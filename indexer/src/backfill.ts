/**
 * Discover recent pools, store them, and assay the ones with liquidity.
 *
 *   pnpm --filter @fineness/indexer backfill
 */
import { ArcRpc } from './rpc.js';
import { Db, defaultDbPath } from './db.js';
import { discoverPools } from './pools.js';
import { Oracle, marketCapUsd, markFor } from './oracle.js';
import { buildHolderSnapshot } from './holders.js';

const BLOCKS = BigInt(process.env.BACKFILL_BLOCKS ?? 3000);

async function main() {
  const rpc = new ArcRpc({ url: process.env.ARC_RPC_URL ?? 'https://rpc.mainnet.arc.io' });
  const db = new Db(process.env.DATABASE_PATH ?? defaultDbPath());

  const head = await rpc.blockNumber();
  console.log(`head ${head} — discovering pools over the last ${BLOCKS} blocks`);

  const pools = await discoverPools(rpc, head - BLOCKS, head);
  for (const p of pools) db.upsertPool(p);
  db.setCursor('pools', head);

  const assayable = pools.filter((p) => p.token);
  console.log(`stored ${pools.length} pools (${assayable.length} assayable)\n`);

  const oracle = new Oracle(rpc, {
    artifacts: {
      fineness: new URL('../../contracts/out/Fineness.sol/Fineness.json', import.meta.url),
      simulator: new URL('../../contracts/out/Simulator.sol/Simulator.json', import.meta.url),
    },
  });

  let ok = 0, failed = 0;
  for (const p of assayable.slice(0, Number(process.env.ASSAY_LIMIT ?? 8))) {
    try {
      const r = await oracle.check(p);
      db.saveReport({
        token: r.token, poolId: p.poolId, score: r.grade,
        grade: r.grade, isHoneypot: r.isHoneypot,
        buyTaxBps: r.buyTaxBps, sellTaxBps: r.sellTaxBps, poolFeeBps: r.poolFeeBps,
        hookFeeBps: r.hookFeeBps, hookPermissions: r.hookPermissions,
        hookCanInterceptSwap: r.hookCanInterceptSwap,
        ownershipRenounced: r.ownershipRenounced, mayBeUpgradeable: r.mayBeUpgradeable,
        dynamicFee: r.dynamicFee, flags: r.flags, checkedAt: Date.now(),
      });
      // Market cap from the realised probe price, then the holder snapshot.
      // Concentration is only meaningful relative to market cap, so the two
      // have to be computed together or not at all.
      let mcap: number | null = null;
      try {
        const supplyHex = await rpc.call<string>('eth_call', [
          { to: p.token, data: '0x18160ddd' }, // totalSupply()
          'latest',
        ]);
        mcap = marketCapUsd(r.usdcProbed, r.tokensOut, BigInt(supplyHex));
      } catch {
        // Leave null. Null means unknown and is reported as NOT_COMPUTED —
        // never silently treated as zero, which would read as "too early".
      }

      try {
        const snap = await buildHolderSnapshot(
          rpc,
          p.token!,
          p.blockNumber,
          head,
          mcap,
        );
        db.saveHolders(snap);
      } catch {
        // A failed holder scan leaves NOT_COMPUTED rather than a wrong verdict.
      }

      const m = markFor(r.grade);
      const cap = mcap === null ? 'mcap ?' : `mcap $${Math.round(mcap).toLocaleString()}`;
      console.log(`  ${m}  ${r.token}  honeypot=${r.isHoneypot}  hookFee=${r.hookFeeBps}bps  ${cap}  ${r.flags.join('; ') || 'clean'}`);
      ok++;
    } catch (e) {
      // Most failures here are pools with no liquidity yet, which is a fact
      // about the pool rather than a fault in the token. Not a verdict.
      console.log(`  ----  ${p.token}  unassayable: ${(e as Error).message.slice(0, 80)}`);
      failed++;
    }
  }
  console.log(`\nassayed ${ok}, unassayable ${failed}`);
  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
