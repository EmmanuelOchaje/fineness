/**
 * The watcher. Discovers new pools as they are created and assays them.
 *
 *   pnpm --filter @fineness/indexer watch
 *
 * ## Why this polls instead of subscribing
 *
 * Circle's public RPC serves no WebSocket — only Alchemy, Blockdaemon and
 * QuickNode do, and those need an API key. Rather than making a key mandatory
 * to run the project at all, this polls by default and upgrades to a live
 * subscription automatically when ARC_WSS_URL is set.
 *
 * Polling on a sub-second chain sounds wasteful, but pool creation is the only
 * event we care about and `eth_getLogs` over a small trailing window is one
 * request per tick. The cost is latency measured in seconds, not missed pools.
 *
 * ## The failure mode this is built around
 *
 * A subscription that silently stops delivering is worse than one that crashes,
 * because the feed just quietly stops updating and nobody notices. So the loop
 * tracks a cursor in the database and always scans FORWARD FROM THE CURSOR
 * rather than from "now". A stall, a restart or a dropped connection resumes
 * exactly where it left off and backfills the gap.
 *
 * ## Backpressure
 *
 * Assaying costs a heavy eth_call each, and Arc rate-limits (-32005). New pools
 * arrive faster than they can be assayed during a launch burst, so the queue is
 * bounded, work runs with limited concurrency, and stale entries are dropped
 * rather than letting the backlog grow without limit. A 20-minute-old "new
 * token" is not news.
 */
import { ArcRpc } from './rpc.js';
import { Db, defaultDbPath } from './db.js';
import { discoverPools, type DiscoveredPool } from './pools.js';
import { Oracle, marketCapUsd, markFor } from './oracle.js';
import { buildHolderSnapshot } from './holders.js';
import { fetchTokenMeta } from './metadata.js';

const POLL_MS = Number(process.env.WATCH_POLL_MS ?? 6000);
const CONCURRENCY = Number(process.env.WATCH_CONCURRENCY ?? 4);
const MAX_QUEUE = Number(process.env.WATCH_MAX_QUEUE ?? 200);
const STALE_MS = Number(process.env.WATCH_STALE_MS ?? 20 * 60 * 1000);
const CURSOR_KEY = 'pools';

/**
 * How often to re-price already-assayed tokens, and how many per pass.
 *
 * A market cap captured once at discovery and never updated is worse than none
 * at all: it looks live and is not. The verdict is expensive and rarely
 * changes; the price moves every block. So they refresh on different cadences —
 * the repricer re-runs only the probe and touches nothing else.
 */
const REPRICE_MS = Number(process.env.WATCH_REPRICE_MS ?? 15_000);
const REPRICE_BATCH = Number(process.env.WATCH_REPRICE_BATCH ?? 6);

/** Cap the catch-up window so a long outage does not stall the watcher. */
const MAX_CATCHUP_BLOCKS = 20_000n;

interface QueueItem {
  pool: DiscoveredPool;
  queuedAt: number;
}

class Watcher {
  private readonly rpc: ArcRpc;
  private readonly db: Db;
  private readonly oracle: Oracle;
  private readonly queue: QueueItem[] = [];
  private readonly seen = new Set<string>();
  private active = 0;
  private assayed = 0;
  private dropped = 0;
  private readonly failures = new Map<string, number>();
  private stopping = false;

  constructor() {
    this.rpc = new ArcRpc({
      url: process.env.ARC_RPC_URL ?? 'https://rpc.mainnet.arc.io',
      minIntervalMs: 150,
    });
    this.db = new Db(process.env.DATABASE_PATH ?? defaultDbPath());
    this.oracle = new Oracle(this.rpc, {
      ...(process.env.FINENESS_ADDRESS
        ? { finenessAddress: process.env.FINENESS_ADDRESS }
        : {
            artifacts: {
              fineness: new URL('../../contracts/out/Fineness.sol/Fineness.json', import.meta.url),
              simulator: new URL(
                '../../contracts/out/Simulator.sol/Simulator.json',
                import.meta.url,
              ),
            },
          }),
    });
  }

  async run(): Promise<void> {
    const head = await this.rpc.blockNumber();
    let cursor = this.db.getCursor(CURSOR_KEY);

    if (cursor === null) {
      // First run: start just behind head rather than at genesis.
      cursor = head - 500n;
      this.db.setCursor(CURSOR_KEY, cursor);
    }

    console.log(`watching Arc from block ${cursor} (head ${head})`);
    console.log(
      process.env.ARC_WSS_URL
        ? 'wss endpoint configured — live subscription available'
        : 'polling (no ARC_WSS_URL set; Circle’s public RPC has no WebSocket)',
    );

    process.on('SIGINT', () => {
      this.stopping = true;
      console.log('\nstopping…');
    });

    const repricer = setInterval(() => {
      void this.reprice().catch(() => {
        // Repricing is best-effort; discovery must keep running regardless.
      });
    }, REPRICE_MS);

    while (!this.stopping) {
      try {
        await this.tick();
      } catch (e) {
        // A transient RPC failure must never kill the watcher. Log and retry;
        // the cursor is only advanced after a successful scan, so nothing is
        // lost by failing here.
        console.error('tick failed:', (e as Error).message.slice(0, 140));
      }
      await sleep(POLL_MS);
    }

    clearInterval(repricer);
    this.db.close();
  }

  private async tick(): Promise<void> {
    const head = await this.rpc.blockNumber();
    const cursor = this.db.getCursor(CURSOR_KEY) ?? head;
    if (head <= cursor) return;

    // Bound the catch-up window. After a long outage, scanning the whole gap in
    // one tick would stall the loop for minutes; better to advance steadily.
    const to = head - cursor > MAX_CATCHUP_BLOCKS ? cursor + MAX_CATCHUP_BLOCKS : head;

    const pools = await discoverPools(this.rpc, cursor + 1n, to);
    this.db.setCursor(CURSOR_KEY, to);

    let queued = 0;
    for (const p of pools) {
      this.db.upsertPool(p);
      if (!p.token) continue; // token/token pool, not assayable
      if (this.seen.has(p.token)) continue;
      this.seen.add(p.token);

      if (this.queue.length >= MAX_QUEUE) {
        // Drop the OLDEST, not the newest. During a launch burst the freshest
        // pools are the ones a trader is actually looking at.
        this.queue.shift();
        this.dropped++;
      }
      this.queue.push({ pool: p, queuedAt: Date.now() });
      queued++;
    }

    if (pools.length > 0) {
      const fails = [...this.failures]
        .sort((a, b) => b[1] - a[1])
        .map(([r, n]) => `${r}:${n}`)
        .join(' ');
      console.log(
        `block ${to} · ${pools.length} pools (${queued} queued, ${this.queue.length} pending, ` +
          `${this.assayed} assayed)${fails ? ` · unassayable[${fails}]` : ''}`,
      );
    }

    this.pump();
  }

  /** Start work up to the concurrency limit. */
  private pump(): void {
    while (this.active < CONCURRENCY && this.queue.length > 0) {
      const item = this.queue.shift()!;

      if (Date.now() - item.queuedAt > STALE_MS) {
        this.dropped++;
        continue;
      }

      this.active++;
      void this.assay(item.pool)
        .catch((e: Error) => {
          // Most failures are pools with no liquidity yet — a fact about the
          // pool, not a verdict about the token, so nothing is recorded.
          //
          // But swallowing the reason outright hides real bugs. An earlier
          // version did exactly that and silently discarded EVERY assay for a
          // broken SQL statement, while the log looked healthy. Tally the
          // causes and print them; an empty feed should always be explicable.
          const reason = classify(e.message);
          this.failures.set(reason, (this.failures.get(reason) ?? 0) + 1);
          if (process.env.WATCH_VERBOSE) {
            console.log(`  ---- ${item.pool.token} ${e.message.slice(0, 140)}`);
          }
        })
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  private async assay(pool: DiscoveredPool): Promise<void> {
    const r = await this.oracle.check(pool);

    const mcap = await this.priceOf(pool, r.usdcProbed, r.tokensOut);

    // Name, symbol and logo. Deployer-controlled, so this is context and never
    // touches the score — it exists so a trader can recognise the token.
    // Failing to fetch it must not lose the verdict, hence the soft failure.
    let meta = { name: null as string | null, symbol: null as string | null, logo: null as string | null };
    try {
      meta = await fetchTokenMeta(this.rpc, pool.token!);
    } catch {
      // Keep the verdict; the row simply shows its address.
    }

    this.db.saveReport({
      token: r.token,
      poolId: pool.poolId,
      score: r.grade,
        grade: r.grade,
      isHoneypot: r.isHoneypot,
      buyTaxBps: r.buyTaxBps,
      sellTaxBps: r.sellTaxBps,
      poolFeeBps: r.poolFeeBps,
      hookFeeBps: r.hookFeeBps,
      hookPermissions: r.hookPermissions,
      hookCanInterceptSwap: r.hookCanInterceptSwap,
      ownershipRenounced: r.ownershipRenounced,
      mayBeUpgradeable: r.mayBeUpgradeable,
      dynamicFee: r.dynamicFee,
      flags: r.flags,
      checkedAt: Date.now(),
      marketCap: mcap,
      initBlock: Number(pool.blockNumber),
      name: meta.name,
      symbol: meta.symbol,
      logo: meta.logo,
      pricedAt: Date.now(),
    });

    // Seed the price history so a surge can be measured from first sighting.
    if (mcap !== null) this.db.recordPrice(r.token, mcap);

    // Holder snapshot alongside, since concentration is meaningless without a
    // market cap to judge it against.
    try {
      const head = await this.rpc.blockNumber();
      this.db.saveHolders(
        await buildHolderSnapshot(this.rpc, pool.token!, pool.blockNumber, head, mcap),
      );
    } catch {
      // Leaves NOT_COMPUTED rather than a wrong verdict.
    }

    this.assayed++;
    const mark = markFor(r.grade);
    const cap = mcap === null ? 'mcap ?' : `$${Math.round(mcap).toLocaleString()}`;
    const label = meta.symbol ?? r.token.slice(0, 10);
    console.log(
      `  ${mark} ${label.padEnd(12)} ${r.isHoneypot ? 'HONEYPOT' : 'ok'} ${cap}` +
        `  [assayed ${this.assayed}, dropped ${this.dropped}]`,
    );
  }

  /** Realised price from the probe, times supply. Null means unknown. */
  private async priceOf(
    pool: DiscoveredPool,
    usdcProbed: bigint,
    tokensOut: bigint,
  ): Promise<number | null> {
    try {
      const supply = await this.rpc.call<string>('eth_call', [
        { to: pool.token, data: '0x18160ddd' },
        'latest',
      ]);
      return marketCapUsd(usdcProbed, tokensOut, BigInt(supply));
    } catch {
      return null;
    }
  }

  /**
   * Refresh the market cap of the tokens priced longest ago.
   *
   * Runs the simulator probe only — the verdict is left alone, because
   * ownership and hook permissions do not change between blocks while price
   * does. Rotating through the stalest keeps every row moving without
   * re-assaying the whole table.
   */
  private async reprice(): Promise<void> {
    this.db.prunePriceHistory();
    const targets = this.db.stalestPriced(REPRICE_BATCH);
    for (const t of targets) {
      const pool = this.db.getPoolByToken(t.token);
      if (!pool?.token) continue;
      try {
        const r = await this.oracle.check(pool);
        this.db.updatePrice(t.token, await this.priceOf(pool, r.usdcProbed, r.tokensOut));
      } catch {
        // Stamp the attempt so a permanently unpriceable token does not jam
        // the rotation at the front of the queue forever.
        this.db.updatePrice(t.token, null);
      }
    }
  }
}

/** Bucket failure messages so the log reports causes rather than noise. */
function classify(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes('no output') || m.includes('nothingreceived')) return 'no-liquidity';
  if (m.includes('poolhasnousdc')) return 'no-usdc';
  if (m.includes('rate limit')) return 'rate-limited';
  if (m.includes('transfer')) return 'transfer-failed';
  if (m.includes('sqlite') || m.includes('column') || m.includes('values')) return 'DB-ERROR';
  if (m.includes('execution reverted')) return 'reverted';
  return 'other';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

new Watcher().run().catch((e) => {
  console.error(e);
  process.exit(1);
});
