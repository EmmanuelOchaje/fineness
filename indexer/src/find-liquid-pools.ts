/**
 * Find pools with genuine, recent swap activity — i.e. real liquidity.
 *
 * Fork tests need pools that actually trade. A pool that was initialized but
 * never funded will make the Simulator revert for reasons that have nothing to
 * do with the token being risky, which is exactly the kind of false signal this
 * project exists to avoid.
 *
 * Strategy: take recent Swap events (proof of liquidity), collect their pool
 * ids, then find each one's Initialize event to recover the full PoolKey.
 *
 *   pnpm --filter @fineness/indexer find-pools
 */
import { analyzeHook, USDC_ADDRESS, V4_POOL_MANAGER } from '@fineness/shared';
import { ArcRpc } from './rpc.js';
import { scanLogs } from './logs.js';
import { decodeInitialize } from './pools.js';

const SWAP_TOPIC = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const INIT_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';

async function main() {
  const rpc = new ArcRpc({ url: process.env.ARC_RPC_URL ?? 'https://rpc.mainnet.arc.io' });
  const head = await rpc.blockNumber();

  // 1. Most-traded pools in the recent past.
  const swaps = await scanLogs(rpc, {
    address: V4_POOL_MANAGER,
    topics: [SWAP_TOPIC],
    fromBlock: head - 3_000n,
    toBlock: head,
  });

  const counts = new Map<string, number>();
  for (const log of swaps) {
    const id = log.topics[1];
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 40);
  console.log(`${swaps.length} swaps across ${counts.size} pools in the last 3000 blocks\n`);

  // 2. Recover each pool's key from its Initialize event. Scanning back in
  //    windows because these pools may have been created some time ago.
  const wanted = new Set(ranked.map(([id]) => id));
  const found = new Map<string, ReturnType<typeof decodeInitialize>>();

  for (let back = 0n; back < 900_000n && found.size < 12; back += 150_000n) {
    const inits = await scanLogs(rpc, {
      address: V4_POOL_MANAGER,
      topics: [INIT_TOPIC],
      fromBlock: head - back - 150_000n,
      toBlock: head - back,
    });
    for (const log of inits) {
      const id = log.topics[1];
      if (!id || !wanted.has(id) || found.has(id)) continue;
      try {
        found.set(id, decodeInitialize(log));
      } catch {
        /* skip malformed */
      }
    }
    process.stdout.write(`\r  matched ${found.size}/${wanted.size} keys...`);
  }
  console.log('\n');

  const usdc = USDC_ADDRESS.toLowerCase();
  for (const [id, count] of ranked) {
    const p = found.get(id);
    if (!p) continue;
    if (p.currency0 !== usdc && p.currency1 !== usdc) continue;

    const a = analyzeHook(p.hooks);
    console.log(`pool ${id}`);
    console.log(`  swaps(3k blocks) ${count}`);
    console.log(`  currency0        ${p.currency0}`);
    console.log(`  currency1        ${p.currency1}`);
    console.log(`  fee ${p.fee}  tickSpacing ${p.tickSpacing}`);
    console.log(`  hooks            ${p.hooks}  perms 0x${a.permissions.toString(16)}`);
    console.log(`  usdcIsCurrency0  ${p.usdcIsCurrency0}`);
    console.log(`  intercepts swap  ${a.dangerous.length > 0}`);
    console.log(`  initBlock        ${p.blockNumber}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
