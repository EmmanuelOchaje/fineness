/**
 * SQLite persistence for discovered pools, cached reports and holder snapshots.
 *
 * Deliberately boring. The interesting correctness lives in the oracle; this is
 * a cache with a clear invalidation rule, and it should stay that way.
 */
// Node's built-in SQLite (Node 22+). Chosen over better-sqlite3 deliberately:
// that package needs a native build with no prebuilt binary for Node 24, which
// turns `pnpm install` into a toolchain problem for anyone cloning this repo.
// Zero dependencies is worth more here than marginal performance.
import { DatabaseSync } from 'node:sqlite';
import type { DiscoveredPool } from './pools.js';
import type { HolderSnapshot } from './holders.js';

/**
 * Default database location, resolved relative to this file rather than the
 * process cwd. pnpm runs scripts with cwd set to the package directory, so a
 * plain relative path resolves differently depending on who invoked it.
 */
export function defaultDbPath(): string {
  return new URL('../fineness.sqlite', import.meta.url).pathname;
}

export interface StoredReport {
  token: string;
  poolId: string;
  score: number;
  grade?: number | null;
  firstSeen?: number | null;
  isHoneypot: boolean;
  buyTaxBps: number;
  sellTaxBps: number;
  poolFeeBps: number;
  hookFeeBps: number;
  hookPermissions: number;
  hookCanInterceptSwap: boolean;
  ownershipRenounced: boolean;
  mayBeUpgradeable: boolean;
  dynamicFee: boolean;
  flags: string[];
  checkedAt: number;
  /** null = could not be derived. Never conflate with zero. */
  marketCap?: number | null;
  initBlock?: number | null;
  name?: string | null;
  symbol?: string | null;
  logo?: string | null;
  pricedAt?: number | null;
}

export class Db {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pools (
        pool_id          TEXT PRIMARY KEY,
        token            TEXT,
        currency0        TEXT NOT NULL,
        currency1        TEXT NOT NULL,
        fee              INTEGER NOT NULL,
        tick_spacing     INTEGER NOT NULL,
        hooks            TEXT NOT NULL,
        usdc_is_currency0 INTEGER NOT NULL,
        has_dynamic_fee  INTEGER NOT NULL,
        -- Block number, not timestamp: Arc timestamps are non-decreasing but
        -- not strictly increasing, so sub-second blocks can share one.
        init_block       INTEGER NOT NULL,
        discovered_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pools_token ON pools(token);
      CREATE INDEX IF NOT EXISTS idx_pools_block ON pools(init_block DESC);

      CREATE TABLE IF NOT EXISTS reports (
        token            TEXT PRIMARY KEY,
        pool_id          TEXT NOT NULL,
        score            INTEGER NOT NULL,
        is_honeypot      INTEGER NOT NULL,
        buy_tax_bps      INTEGER NOT NULL,
        sell_tax_bps     INTEGER NOT NULL,
        pool_fee_bps     INTEGER NOT NULL,
        hook_fee_bps     INTEGER NOT NULL,
        hook_permissions INTEGER NOT NULL,
        hook_intercepts  INTEGER NOT NULL,
        ownership_renounced INTEGER NOT NULL,
        may_be_upgradeable  INTEGER NOT NULL,
        dynamic_fee      INTEGER NOT NULL,
        flags            TEXT NOT NULL,
        checked_at       INTEGER NOT NULL,
        -- NULL means unknown, and must stay distinguishable from 0. A token
        -- whose market cap we failed to derive is not a $0 token.
        market_cap       REAL,
        init_block       INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_reports_score ON reports(score DESC);

      CREATE TABLE IF NOT EXISTS holders (
        token            TEXT PRIMARY KEY,
        holder_count     INTEGER NOT NULL,
        top10_share      REAL NOT NULL,
        verdict          TEXT NOT NULL,
        reason           TEXT NOT NULL,
        snapshot         TEXT NOT NULL,
        to_block         INTEGER NOT NULL,
        checked_at       INTEGER NOT NULL
      );

      /**
       * Price samples, for detecting surges.
       *
       * A token a trader scrolled past is gone forever unless something brings
       * it back. Storing a short price history lets the feed resurface one that
       * has since moved, so a decision deferred is not a decision lost.
       */
      CREATE TABLE IF NOT EXISTS price_history (
        token       TEXT NOT NULL,
        market_cap  REAL NOT NULL,
        at          INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_price_token_at ON price_history(token, at DESC);

      /**
       * Trading activity per token, bucketed per scan.
       *
       * Price change alone is a poor liveness signal here: 25 of 29 sampled
       * tokens were perfectly flat, because nothing was trading them at all.
       * And when price DOES move on a barely-funded pool it moves absurdly —
       * one sample showed +127,770%, which is a liquidity artefact, not a rally.
       *
       * Swap count is the honest measure of "something is happening". It cannot
       * be faked by thin liquidity and it does not care about direction.
       */
      CREATE TABLE IF NOT EXISTS activity (
        token   TEXT NOT NULL,
        swaps   INTEGER NOT NULL,
        at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_activity_token_at ON activity(token, at DESC);

      CREATE TABLE IF NOT EXISTS cursor (
        key              TEXT PRIMARY KEY,
        block            INTEGER NOT NULL
      );
    `);

    // Additive migrations for databases created before these columns existed.
    for (const [col, type] of [
      ['market_cap', 'REAL'],
      ['init_block', 'INTEGER'],
      ['name', 'TEXT'],
      ['symbol', 'TEXT'],
      ['logo', 'TEXT'],
      // Assay time vs price time are different questions. The verdict is
      // expensive and stable; the price moves every block. Tracking them
      // separately lets the repricer refresh one without redoing the other.
      ['priced_at', 'INTEGER'],
      ['grade', 'INTEGER'],
      // When we FIRST assayed this token, never overwritten. A resurfaced row
      // has to be able to say "you saw this 3 hours ago", and checked_at moves
      // on every re-assay so it cannot answer that.
      ['first_seen', 'INTEGER'],
    ]) {
      try {
        this.db.exec(`ALTER TABLE reports ADD COLUMN ${col} ${type}`);
      } catch {
        // Already present.
      }
    }
  }

  upsertPool(p: DiscoveredPool): void {
    this.db
      .prepare(
        `INSERT INTO pools (pool_id, token, currency0, currency1, fee, tick_spacing,
           hooks, usdc_is_currency0, has_dynamic_fee, init_block, discovered_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(pool_id) DO NOTHING`,
      )
      .run(
        p.poolId,
        p.token,
        p.currency0,
        p.currency1,
        p.fee,
        p.tickSpacing,
        p.hooks,
        p.usdcIsCurrency0 ? 1 : 0,
        p.hasDynamicFee ? 1 : 0,
        Number(p.blockNumber),
        Date.now(),
      );
  }

  /** Pools we can actually assay — a USDC pair. ~94% of the chain. */
  recentAssayablePools(limit = 100): DiscoveredPool[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pools WHERE token IS NOT NULL
         ORDER BY init_block DESC LIMIT ?`,
      )
      .all(limit) as Record<string, never>[];
    return rows.map((r) => this.rowToPool(r));
  }

  /** Token for a pool id, for attributing swap activity. */
  tokenForPool(poolId: string): string | null {
    const r = this.db
      .prepare(`SELECT token FROM pools WHERE pool_id = ?`)
      .get(poolId) as { token: string | null } | undefined;
    return r?.token ?? null;
  }

  getPoolByToken(token: string): DiscoveredPool | null {
    const r = this.db
      .prepare(`SELECT * FROM pools WHERE token = ? ORDER BY init_block DESC LIMIT 1`)
      .get(token.toLowerCase()) as Record<string, never> | undefined;
    return r ? this.rowToPool(r) : null;
  }

  private rowToPool(r: Record<string, never>): DiscoveredPool {
    const g = (k: string) => (r as Record<string, unknown>)[k];
    return {
      poolId: g('pool_id') as string,
      token: g('token') as DiscoveredPool['token'],
      currency0: g('currency0') as DiscoveredPool['currency0'],
      currency1: g('currency1') as DiscoveredPool['currency1'],
      fee: g('fee') as number,
      tickSpacing: g('tick_spacing') as number,
      hooks: g('hooks') as DiscoveredPool['hooks'],
      usdcIsCurrency0: g('usdc_is_currency0') === 1,
      hasDynamicFee: g('has_dynamic_fee') === 1,
      blockNumber: BigInt(g('init_block') as number),
    };
  }

  saveReport(r: StoredReport): void {
    this.db
      .prepare(
        `INSERT INTO reports (token, pool_id, score, is_honeypot, buy_tax_bps,
           sell_tax_bps, pool_fee_bps, hook_fee_bps, hook_permissions,
           hook_intercepts, ownership_renounced, may_be_upgradeable, dynamic_fee,
           flags, checked_at, market_cap, init_block, name, symbol, logo, priced_at,
           grade, first_seen)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(token) DO UPDATE SET
           score=excluded.score, is_honeypot=excluded.is_honeypot,
           buy_tax_bps=excluded.buy_tax_bps, sell_tax_bps=excluded.sell_tax_bps,
           pool_fee_bps=excluded.pool_fee_bps, hook_fee_bps=excluded.hook_fee_bps,
           hook_permissions=excluded.hook_permissions,
           hook_intercepts=excluded.hook_intercepts,
           ownership_renounced=excluded.ownership_renounced,
           may_be_upgradeable=excluded.may_be_upgradeable,
           dynamic_fee=excluded.dynamic_fee, flags=excluded.flags,
           checked_at=excluded.checked_at, market_cap=excluded.market_cap,
           init_block=excluded.init_block, priced_at=excluded.priced_at,
           -- Metadata is only overwritten when the new value is non-null, so a
           -- transient IPFS or RPC failure cannot erase a name we already have.
           grade=excluded.grade,
           -- COALESCE keeps the ORIGINAL sighting: first_seen is set once.
           first_seen=COALESCE(reports.first_seen, excluded.first_seen),
           name=COALESCE(excluded.name, reports.name),
           symbol=COALESCE(excluded.symbol, reports.symbol),
           logo=COALESCE(excluded.logo, reports.logo)`,
      )
      .run(
        r.token.toLowerCase(), r.poolId, r.score, r.isHoneypot ? 1 : 0,
        r.buyTaxBps, r.sellTaxBps, r.poolFeeBps, r.hookFeeBps, r.hookPermissions,
        r.hookCanInterceptSwap ? 1 : 0, r.ownershipRenounced ? 1 : 0,
        r.mayBeUpgradeable ? 1 : 0, r.dynamicFee ? 1 : 0,
        JSON.stringify(r.flags), r.checkedAt,
        r.marketCap ?? null, r.initBlock ?? null,
        r.name ?? null, r.symbol ?? null, r.logo ?? null,
        r.pricedAt ?? r.checkedAt,
        r.grade ?? null,
        r.firstSeen ?? r.checkedAt,
      );
  }

  getReport(token: string): StoredReport | null {
    const r = this.db
      .prepare(`SELECT * FROM reports WHERE token = ?`)
      .get(token.toLowerCase()) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      token: r.token as string,
      poolId: r.pool_id as string,
      score: r.score as number,
      isHoneypot: r.is_honeypot === 1,
      buyTaxBps: r.buy_tax_bps as number,
      sellTaxBps: r.sell_tax_bps as number,
      poolFeeBps: r.pool_fee_bps as number,
      hookFeeBps: r.hook_fee_bps as number,
      hookPermissions: r.hook_permissions as number,
      hookCanInterceptSwap: r.hook_intercepts === 1,
      ownershipRenounced: r.ownership_renounced === 1,
      mayBeUpgradeable: r.may_be_upgradeable === 1,
      dynamicFee: r.dynamic_fee === 1,
      flags: JSON.parse(r.flags as string) as string[],
      checkedAt: r.checked_at as number,
      marketCap: (r.market_cap as number | null) ?? null,
      initBlock: (r.init_block as number | null) ?? null,
      name: (r.name as string | null) ?? null,
      symbol: (r.symbol as string | null) ?? null,
      logo: (r.logo as string | null) ?? null,
      pricedAt: (r.priced_at as number | null) ?? null,
      grade: (r.grade as number | null) ?? null,
      firstSeen: (r.first_seen as number | null) ?? (r.checked_at as number),
    };
  }

  listReports(limit = 100, minMarketCap = 0): StoredReport[] {
    // A NULL market cap is unknown, not zero. When a floor is applied, unknown
    // tokens are included rather than silently hidden — the feed says it could
    // not price them instead of pretending they are worthless.
    const rows = this.db
      .prepare(
        `SELECT token FROM reports
         WHERE ? = 0 OR market_cap IS NULL OR market_cap >= ?
         ORDER BY checked_at DESC LIMIT ?`,
      )
      .all(minMarketCap, minMarketCap, limit) as { token: string }[];
    return rows.map((r) => this.getReport(r.token)!).filter(Boolean);
  }

  /**
   * What to reprice next, most important first.
   *
   * Ordered by recent trading activity, then by staleness. Repricing on pure
   * staleness spends the entire RPC budget on dead tokens: on Arc most tokens
   * never trade, so their market cap is correctly constant and refreshing it
   * every few seconds buys nothing. The handful that ARE trading are the only
   * ones whose number is actually moving, and they are what a live feed is for.
   */
  repriceTargets(
    limit = 10,
    activityWindowMs = 15 * 60 * 1000,
    visible = 150,
  ): { token: string; poolId: string }[] {
    const since = Date.now() - activityWindowMs;

    // Half the budget to tokens that are actually trading — their number is
    // the only one genuinely moving.
    const half = Math.max(1, Math.floor(limit / 2));
    const active = this.db
      .prepare(
        `SELECT r.token, r.pool_id AS poolId,
                COALESCE((SELECT SUM(a.swaps) FROM activity a
                          WHERE a.token = r.token AND a.at >= ?), 0) AS act
         FROM reports r
         WHERE act > 0
         ORDER BY act DESC, COALESCE(r.priced_at, r.checked_at) ASC
         LIMIT ?`,
      )
      .all(since, half) as { token: string; poolId: string }[];

    // The other half to whatever has waited longest AMONG THE ROWS A USER CAN
    // SEE. Ordering purely by activity starved everything else: with a
    // thousand tracked tokens the same handful was re-selected every pass and
    // the median price age reached 59 minutes, so most of the feed showed
    // hour-old numbers. Tokens far below the visible window do not need
    // refreshing at all — nobody is looking at them.
    const taken = new Set(active.map((a) => a.token));
    const stale = this.db
      .prepare(
        `SELECT token, pool_id AS poolId FROM (
           SELECT token, pool_id, priced_at, checked_at FROM reports
           ORDER BY COALESCE(init_block, 0) DESC LIMIT ?
         ) ORDER BY COALESCE(priced_at, checked_at) ASC LIMIT ?`,
      )
      .all(visible, limit) as { token: string; poolId: string }[];

    const out = [...active];
    for (const r of stale) {
      if (out.length >= limit) break;
      if (!taken.has(r.token)) out.push(r);
    }
    return out;
  }

  /** Update just the price fields, leaving the verdict untouched. */
  updatePrice(token: string, marketCap: number | null): void {
    const now = Date.now();
    this.db
      .prepare(`UPDATE reports SET market_cap = ?, priced_at = ? WHERE token = ?`)
      .run(marketCap, now, token.toLowerCase());
    if (marketCap !== null) this.recordPrice(token, marketCap, now);
  }

  recordPrice(token: string, marketCap: number, at = Date.now()): void {
    this.db
      .prepare(`INSERT INTO price_history (token, market_cap, at) VALUES (?,?,?)`)
      .run(token.toLowerCase(), marketCap, at);
  }

  /**
   * Percentage change over a window, or null when there is no comparable
   * sample. Null means "not enough history", never 0% — a token we have only
   * just met has not been flat, it has been unobserved.
   */
  priceChangePct(token: string, windowMs: number): { pct: number; sinceMs: number } | null {
    const t = token.toLowerCase();
    const cur = this.db
      .prepare(`SELECT market_cap AS c FROM reports WHERE token = ?`)
      .get(t) as { c: number | null } | undefined;
    if (!cur?.c) return null;

    // Prefer a sample at least `windowMs` old. If we have not been watching
    // that long, fall back to the OLDEST sample we do have and report how far
    // back it actually reaches.
    //
    // A column that shows "—" for an hour because it insists on a 15-minute
    // baseline is worse than one that says "+4% over 3 minutes": the first
    // looks broken, the second is true and immediately useful.
    const at = Date.now() - windowMs;
    const row = (this.db
      .prepare(
        `SELECT market_cap AS old, at FROM price_history
         WHERE token = ? AND at <= ? ORDER BY at DESC LIMIT 1`,
      )
      .get(t, at) ??
      this.db
        .prepare(
          `SELECT market_cap AS old, at FROM price_history
           WHERE token = ? ORDER BY at ASC LIMIT 1`,
        )
        .get(t)) as { old: number; at: number } | undefined;

    if (!row || row.old <= 0) return null;
    // A single sample taken moments ago says nothing yet.
    if (Date.now() - row.at < 30_000) return null;

    return { pct: ((cur.c - row.old) / row.old) * 100, sinceMs: Date.now() - row.at };
  }

  recordActivity(token: string, swaps: number, at = Date.now()): void {
    if (swaps <= 0) return;
    this.db
      .prepare(`INSERT INTO activity (token, swaps, at) VALUES (?,?,?)`)
      .run(token.toLowerCase(), swaps, at);
  }

  /** Swaps seen for a token within the window. */
  swapsIn(token: string, windowMs: number): number {
    const r = this.db
      .prepare(`SELECT COALESCE(SUM(swaps),0) AS n FROM activity WHERE token = ? AND at >= ?`)
      .get(token.toLowerCase(), Date.now() - windowMs) as { n: number } | undefined;
    return r?.n ?? 0;
  }

  /** Keep the history bounded; this is a live feed, not an archive. */
  prunePriceHistory(olderThanMs = 6 * 60 * 60 * 1000): void {
    const cutoff = Date.now() - olderThanMs;
    this.db.prepare(`DELETE FROM price_history WHERE at < ?`).run(cutoff);
    this.db.prepare(`DELETE FROM activity WHERE at < ?`).run(cutoff);
  }

  /** Most recent assay timestamp, for change detection on the stream. */
  latestCheckedAt(): number {
    const r = this.db
      .prepare(`SELECT MAX(COALESCE(priced_at, checked_at)) AS t FROM reports`)
      .get() as { t: number | null } | undefined;
    return r?.t ?? 0;
  }

  saveHolders(s: HolderSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO holders (token, holder_count, top10_share, verdict, reason,
           snapshot, to_block, checked_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(token) DO UPDATE SET
           holder_count=excluded.holder_count, top10_share=excluded.top10_share,
           verdict=excluded.verdict, reason=excluded.reason,
           snapshot=excluded.snapshot, to_block=excluded.to_block,
           checked_at=excluded.checked_at`,
      )
      .run(
        s.token.toLowerCase(), s.holderCount, s.top10Share, s.verdict, s.reason,
        JSON.stringify(s.top10, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
        Number(s.toBlock), Date.now(),
      );
  }

  getHolders(token: string): Record<string, unknown> | null {
    const r = this.db
      .prepare(`SELECT * FROM holders WHERE token = ?`)
      .get(token.toLowerCase()) as Record<string, unknown> | undefined;
    if (!r) return null;
    return { ...r, snapshot: JSON.parse(r.snapshot as string) as unknown };
  }

  getCursor(key: string): bigint | null {
    const r = this.db.prepare(`SELECT block FROM cursor WHERE key = ?`).get(key) as
      | { block: number }
      | undefined;
    return r ? BigInt(r.block) : null;
  }

  setCursor(key: string, block: bigint): void {
    this.db
      .prepare(
        `INSERT INTO cursor (key, block) VALUES (?,?)
         ON CONFLICT(key) DO UPDATE SET block=excluded.block`,
      )
      .run(key, Number(block));
  }

  close(): void {
    this.db.close();
  }
}
