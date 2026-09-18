/**
 * Fineness API — read-only.
 *
 * This service never holds a key and never signs anything. It reads the
 * indexer's database, and when a cached report is stale it re-runs `check()`
 * against the oracle via `eth_call`. A compromised API can lie about a verdict
 * but cannot move anyone's money.
 *
 *   pnpm --filter @fineness/api dev
 */
import Fastify from 'fastify';
import { Db, defaultDbPath } from '../../indexer/src/db.js';
import { ArcRpc } from '../../indexer/src/rpc.js';
import { Oracle } from '../../indexer/src/oracle.js';
import { analyzeHook } from '@fineness/shared';

const REPORT_TTL_MS = 5 * 60 * 1000;
const PORT = Number(process.env.PORT ?? 8080);

const db = new Db(process.env.DATABASE_PATH ?? defaultDbPath());
const rpc = new ArcRpc({ url: process.env.ARC_RPC_URL ?? 'https://rpc.mainnet.arc.io' });

const oracle = new Oracle(rpc, {
  ...(process.env.FINENESS_ADDRESS ? { finenessAddress: process.env.FINENESS_ADDRESS } : {}),
  ...(process.env.FINENESS_ADDRESS
    ? {}
    : {
        // Not deployed yet — inject the compiled bytecode. Identical code path.
        artifacts: {
          fineness: new URL('../../contracts/out/Fineness.sol/Fineness.json', import.meta.url),
          simulator: new URL('../../contracts/out/Simulator.sol/Simulator.json', import.meta.url),
        },
      }),
});

const app = Fastify({ logger: true });

// The web app runs on a different port, so the browser needs CORS to open the
// SSE stream. Read-only service with no credentials, so a permissive origin is
// safe here — there is nothing to steal and nothing to authorise.
app.addHook('onRequest', async (_req, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Headers', '*');
});

/** The fineness mark: a score of 0-1000 rendered as an assay hallmark. */
function mark(score: number): string {
  return `.${String(Math.max(0, Math.min(1000, score))).padStart(3, '0')}`.slice(0, 4);
}

app.get('/health', async () => ({ ok: true, chain: 5042 }));

/**
 * GET /tokens — the feed.
 *
 * Filterable by minimum score. Deliberately does NOT fetch context data per
 * row: the context layer is lazy and detail-only, because a hanging social
 * fetch must never slow down or block a feed of verdicts.
 */
app.get<{ Querystring: { limit?: string; minScore?: string; minMcap?: string } }>(
  '/tokens',
  async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const minScore = Number(req.query.minScore ?? 0);
    const minMcap = Number(req.query.minMcap ?? 0);

    const reports = db
      .listReports(limit * 2, minMcap)
      .filter((r) => r.score >= minScore)
      .slice(0, limit);

    return {
      count: reports.length,
      latest: db.latestCheckedAt(),
      tokens: reports.map((r) => ({
        token: r.token,
        mark: mark(r.score),
        score: r.score,
        isHoneypot: r.isHoneypot,
        tokenTaxBps: r.buyTaxBps + r.sellTaxBps,
        venueFeeBps: r.poolFeeBps + r.hookFeeBps,
        marketCap: r.marketCap ?? null,
        flags: r.flags,
        checkedAt: r.checkedAt,
      })),
    };
  },
);

/**
 * GET /stream — Server-Sent Events.
 *
 * SSE rather than WebSocket: it is one-directional, which is all a feed needs,
 * it survives proxies that mangle upgrade headers, and browsers reconnect on
 * their own. A dropped feed that silently stops updating is the failure mode
 * that matters here, and SSE's built-in retry handles it without custom code.
 *
 * Emits only when something actually changed, so an idle chain costs nothing
 * beyond the keep-alive.
 */
app.get<{ Querystring: { minMcap?: string } }>('/stream', (req, reply) => {
  const minMcap = Number(req.query.minMcap ?? 0);

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let lastSeen = 0;

  const push = () => {
    const latest = db.latestCheckedAt();
    if (latest === lastSeen) {
      reply.raw.write(': keep-alive\n\n');
      return;
    }
    lastSeen = latest;
    const rows = db.listReports(40, minMcap).map((r) => ({
      token: r.token,
      mark: mark(r.score),
      score: r.score,
      isHoneypot: r.isHoneypot,
      tokenTaxBps: r.buyTaxBps + r.sellTaxBps,
      venueFeeBps: r.poolFeeBps + r.hookFeeBps,
      marketCap: r.marketCap ?? null,
      flags: r.flags,
      checkedAt: r.checkedAt,
    }));
    reply.raw.write(`data: ${JSON.stringify({ latest, tokens: rows })}\n\n`);
  };

  push();
  const timer = setInterval(push, 3000);

  req.raw.on('close', () => {
    clearInterval(timer);
    reply.raw.end();
  });
});

/**
 * GET /tokens/:address — the assay report.
 *
 * Re-runs the oracle when the cached report is older than the TTL. The response
 * separates `verified` from `context` at the top level so a client cannot
 * accidentally render unverified data with verdict styling.
 */
app.get<{ Params: { address: string } }>('/tokens/:address', async (req, reply) => {
  const address = req.params.address.toLowerCase();

  const pool = db.getPoolByToken(address);
  if (!pool) return reply.code(404).send({ error: 'Token not found in the index' });
  if (!pool.token) {
    return reply.code(422).send({
      error: 'Pool contains no USDC and cannot be assayed',
      detail: 'About 6% of Arc pools are token/token. Multi-hop routing is out of scope.',
    });
  }

  let cached = db.getReport(address);
  const stale = !cached || Date.now() - cached.checkedAt > REPORT_TTL_MS;

  if (stale) {
    try {
      const fresh = await oracle.check(pool);
      db.saveReport({
        token: fresh.token,
        poolId: pool.poolId,
        score: fresh.score,
        isHoneypot: fresh.isHoneypot,
        buyTaxBps: fresh.buyTaxBps,
        sellTaxBps: fresh.sellTaxBps,
        poolFeeBps: fresh.poolFeeBps,
        hookFeeBps: fresh.hookFeeBps,
        hookPermissions: fresh.hookPermissions,
        hookCanInterceptSwap: fresh.hookCanInterceptSwap,
        ownershipRenounced: fresh.ownershipRenounced,
        mayBeUpgradeable: fresh.mayBeUpgradeable,
        dynamicFee: fresh.dynamicFee,
        flags: fresh.flags,
        checkedAt: Date.now(),
      });
      cached = db.getReport(address);
    } catch (err) {
      // A failed re-check must not erase a verdict we already have.
      if (!cached) {
        return reply.code(502).send({ error: 'Oracle call failed', detail: String(err) });
      }
      app.log.warn({ err }, 'oracle refresh failed; serving cached report');
    }
  }

  const holders = db.getHolders(address);
  const hook = analyzeHook(pool.hooks);

  return {
    token: address,
    mark: mark(cached!.score),
    score: cached!.score,

    // Everything under here is deterministic and provable on-chain.
    verified: {
      isHoneypot: cached!.isHoneypot,
      tokenTax: { buyBps: cached!.buyTaxBps, sellBps: cached!.sellTaxBps },
      // Kept separate from token tax on purpose: a 1% launchpad fee is the cost
      // of doing business, a 20% token tax is a warning.
      venueFee: { poolBps: cached!.poolFeeBps, hookBps: cached!.hookFeeBps },
      authority: {
        ownershipRenounced: cached!.ownershipRenounced,
        mayBeUpgradeable: cached!.mayBeUpgradeable,
        note: cached!.mayBeUpgradeable
          ? 'Bytecode can DELEGATECALL. Solidity cannot read another contract\'s storage, so the EIP-1967 admin slot is checked off-chain.'
          : 'No DELEGATECALL in bytecode — cannot be an upgradeable proxy.',
      },
      hook: {
        address: pool.hooks,
        permissions: `0x${hook.permissions.toString(16).padStart(4, '0')}`,
        granted: hook.granted,
        matchesEcosystemBaseline: hook.matchesBaseline,
        canInterceptSwap: hook.dangerous.length > 0,
        note: hook.matchesBaseline
          ? 'Standard launchpad fee hook — the norm on Arc (94% of hooked pools).'
          : hook.dangerous.length > 0
            ? 'Holds permissions that could block or reprice a sell. The sell simulation is the actual evidence; this is capability, not proof.'
            : 'Permissions differ from the ecosystem norm but cannot affect swaps.',
      },
      dynamicFee: cached!.dynamicFee,
      concentration: holders
        ? {
            top10Share: holders.top10_share,
            verdict: holders.verdict,
            reason: holders.reason,
          }
        : {
            // NOT_COMPUTED, never INSUFFICIENT_DATA. The first says we have not
            // looked; the second says we looked and the token is too young to
            // judge. Rendering them identically is the failure mode this whole
            // product is built to avoid.
            verdict: 'NOT_COMPUTED',
            reason: 'Holder snapshot has not been built for this token yet.',
          },
      flags: cached!.flags,
      checkedAt: cached!.checkedAt,
    },

    // Separate top-level object, never merged into `verified`. Unscored by
    // design — see the README. Empty until the context service lands.
    context: {
      available: false,
      note: 'Context is displayed but never scored. Not yet implemented.',
    },

    pool: {
      poolId: pool.poolId,
      fee: pool.fee,
      usdcIsCurrency0: pool.usdcIsCurrency0,
      initBlock: Number(pool.blockNumber),
    },
  };
});

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`Fineness API on :${PORT}`))
  .catch((e) => {
    app.log.error(e);
    process.exit(1);
  });
