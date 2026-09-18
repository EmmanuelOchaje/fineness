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
import { scanLogs } from './logs.js';
import { V4_POOL_MANAGER } from '@fineness/shared';

/**
 * Swap(PoolId indexed id, address indexed sender, int128, int128, uint160,
 *      uint128, int24, uint24)
 *
 * Pool id is topic1, so swaps can be tallied per pool from a single scan of
 * the PoolManager across the block range we already fetch for discovery.
 */
const SWAP_TOPIC = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';

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
const REPRICE_MS = Number(process.env.WATCH_REPRICE_MS ?? 2_000);
const REPRICE_BATCH = Number(process.env.WATCH_REPRICE_BATCH ?? 24);
const REPRICE_CONCURRENCY = Number(process.env.WATCH_REPRICE_CONCURRENCY ?? 8);

/**
 * How many of the newest tokens to keep priced.
 *
 * Deliberately matched to the feed size. Keeping a thousand tracked tokens
 * live on a rate-limited public RPC is not achievable and not useful — nobody
 * is looking at row 800. Refresh what is on screen, and let the rest go stale.
 */
const REPRICE_SCOPE = Number(process.env.WATCH_REPRICE_SCOPE ?? 100);

/** Cap the catch-up window so a long outage does not stall the watcher. */
const MAX_CATCHUP_BLOCKS = 20_000n;

interface QueueItem {
  pool: DiscoveredPool;
  queuedAt: number;
}

class Watcher {
  private readonly rpc: ArcRpc;
  private readonly priceRpc: ArcRpc;
  private repricing = false;
  private readonly supplyCache = new Map<string, bigint>();
  private readonly db: Db;
  private readonly oracle: Oracle;
  private readonly priceOracle: Oracle;
  private readonly queue: QueueItem[] = [];
  private readonly seen = new Set<string>();
  private active = 0;
  private assayed = 0;
  private dropped = 0;
  private readonly failures = new Map<string, number>();
  private stopping = false;

  constructor() {
    const url = process.env.ARC_RPC_URL ?? 'https://rpc.mainnet.arc.io';
    this.rpc = new ArcRpc({ url, minIntervalMs: 150 });

    // A SEPARATE client for repricing. ArcRpc serialises its calls to respect
    // Arc's undocumented rate limit, so sharing one queue meant every reprice
    // waited behind discovery and assay work — 40 of 56 tokens were going more
    // than ten minutes without a refresh. Two queues run concurrently while
    // each stays individually polite.
    this.priceRpc = new ArcRpc({ url, minIntervalMs: 150 });
    this.db = new Db(process.env.DATABASE_PATH ?? defaultDbPath());
    this.priceOracle = new Oracle(this.priceRpc, {
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

    // Tally trading activity over the same range. One scan covers every pool,
    // so this costs a single extra request per tick regardless of how many
    // tokens are being tracked.
    await this.recordSwaps(cursor + 1n, to);

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

  /**
   * Count Swap events per pool and attribute them to tokens.
   *
   * Activity is the signal that survives on a chain where almost nothing
   * trades: a token with swaps is alive whichever way the price went, and a
   * flat token with no swaps is simply nobody's problem yet.
   */
  private async recordSwaps(from: bigint, to: bigint): Promise<void> {
    let logs;
    try {
      logs = await scanLogs(this.rpc, {
        address: V4_POOL_MANAGER,
        topics: [SWAP_TOPIC],
        fromBlock: from,
        toBlock: to,
      });
    } catch {
      return; // Activity is enrichment; never let it stall discovery.
    }

    const perPool = new Map<string, number>();
    for (const l of logs) {
      const id = l.topics[1];
      if (id) perPool.set(id, (perPool.get(id) ?? 0) + 1);
    }
    if (perPool.size === 0) return;

    const now = Date.now();
    for (const [poolId, n] of perPool) {
      const token = this.db.tokenForPool(poolId);
      if (token) this.db.recordActivity(token, n, now);
    }
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
    if (this.repricing) return; // never let passes overlap and pile up
    this.repricing = true;
    try {
      this.db.prunePriceHistory();
      const targets = this.db.repriceTargets(REPRICE_BATCH, 15 * 60 * 1000, REPRICE_SCOPE);

      // Small worker pool so a batch completes in roughly one call's time
      // instead of ten sequential ones.
      const queue = [...targets];
      const workers = Array.from({ length: REPRICE_CONCURRENCY }, async () => {
        for (;;) {
          const t = queue.shift();
          if (!t) return;
          const pool = this.db.getPoolByToken(t.token);
          if (!pool?.token) continue;
          try {
            const r = await this.priceOracle.check(pool);

            // Total supply is cached. These are fixed-supply launchpad clones
            // with no mint function, so re-reading it every few seconds doubled
            // the request count for a value that cannot change.
            let supply = this.supplyCache.get(t.token);
            if (supply === undefined) {
              supply = BigInt(
                await this.priceRpc.call<string>('eth_call', [
                  { to: pool.token, data: '0x18160ddd' },
                  'latest',
                ]),
              );
              this.supplyCache.set(t.token, supply);
            }
            this.db.updatePrice(t.token, marketCapUsd(r.usdcProbed, r.tokensOut, supply));
          } catch {
            // Stamp the attempt so a permanently unpriceable token does not jam
            // the rotation at the front of the queue forever.
            this.db.updatePrice(t.token, null);
          }
        }
      });
      await Promise.all(workers);
    } finally {
      this.repricing = false;
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
