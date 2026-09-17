/**
 * Re-run the Arc pool survey.
 *
 * The hook baseline this product scores against (0x2044) is an EMPIRICAL
 * measurement of a days-old chain, not a specification. If a second launchpad
 * ships with different permissions, "anomalous" starts flagging honest tokens
 * and the mark degrades quietly.
 *
 * So the survey is a committed, re-runnable script rather than a number someone
 * typed once. Re-run it before submission, and whenever the flag rate looks off.
 *
 *   pnpm --filter @fineness/indexer survey
 */
import type { Address } from 'viem';
import { arc, ARC_BASELINE_PERMISSIONS, analyzeHook, USDC_ADDRESS } from '@fineness/shared';
import { discoverPools } from './pools.js';
import { ArcRpc } from './rpc.js';

const SAMPLE_BLOCKS = 250_000n;

async function main() {
  const rpc = new ArcRpc({
    url: process.env.ARC_RPC_URL ?? 'https://rpc.mainnet.arc.io',
  });

  const head = await rpc.blockNumber();
  const from = head - SAMPLE_BLOCKS;
  console.log(`Arc chain ${arc.id} · head ${head} · scanning back ${SAMPLE_BLOCKS} blocks\n`);

  const pools = await discoverPools(rpc, from, head, undefined, (_f, to, found) => {
    const pctDone = Number(((to - from) * 100n) / (head - from));
    process.stdout.write(`\r  scanning... ${pctDone}%  (${found} pools)   `);
  });
  process.stdout.write('\n\n');
  if (pools.length === 0) {
    console.log('No pools found in range.');
    return;
  }

  const usdc = USDC_ADDRESS.toLowerCase();
  let c0 = 0, c1 = 0, none = 0, hooked = 0, dynamic = 0;
  const hookAddrs = new Set<string>();
  const permCounts = new Map<number, number>();
  const feeCounts = new Map<number, number>();
  const anomalous: { token: Address | null; hook: string; perms: number }[] = [];

  for (const p of pools) {
    if (p.currency0 === usdc) c0++;
    else if (p.currency1 === usdc) c1++;
    else none++;

    if (p.hasDynamicFee) dynamic++;
    feeCounts.set(p.fee, (feeCounts.get(p.fee) ?? 0) + 1);

    const a = analyzeHook(p.hooks);
    if (!a.isZeroHook) {
      hooked++;
      hookAddrs.add(p.hooks);
      permCounts.set(a.permissions, (permCounts.get(a.permissions) ?? 0) + 1);
      if (a.dangerous.length > 0) {
        anomalous.push({ token: p.token, hook: p.hooks, perms: a.permissions });
      }
    }
  }

  const pct = (n: number) => `${((n / pools.length) * 100).toFixed(1)}%`;

  console.log(`pools                 ${pools.length}`);
  console.log(`USDC is currency0     ${c0} (${pct(c0)})`);
  console.log(`USDC is currency1     ${c1} (${pct(c1)})`);
  console.log(`no USDC (unassayable) ${none} (${pct(none)})`);
  console.log(`dynamic fee           ${dynamic}`);
  console.log(`hooked pools          ${hooked} (${pct(hooked)})`);
  console.log(`distinct hooks        ${hookAddrs.size}`);

  console.log('\nfee tiers:');
  for (const [fee, n] of [...feeCounts].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`  ${fee.toString().padStart(8)}  ${n}`);
  }

  console.log('\nhook permission distribution:');
  for (const [perms, n] of [...permCounts].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    const flags = analyzeHook(`0x${perms.toString(16).padStart(40, '0')}`).granted;
    const mark = perms === ARC_BASELINE_PERMISSIONS ? ' <- baseline' : '';
    console.log(`  0x${perms.toString(16).padStart(4, '0')}  ${String(n).padStart(5)}  ${flags.join(' | ')}${mark}`);
  }

  const baselineCount = permCounts.get(ARC_BASELINE_PERMISSIONS) ?? 0;
  const share = hooked > 0 ? (baselineCount / hooked) * 100 : 0;
  console.log(
    `\nbaseline 0x${ARC_BASELINE_PERMISSIONS.toString(16)} covers ${share.toFixed(1)}% of hooked pools`,
  );

  if (share < 80) {
    console.log(
      '\n⚠️  The baseline no longer dominates. Re-measure it before trusting the\n' +
        '    score — a second launchpad pattern may have appeared.',
    );
  }

  console.log(`\npools whose hook can intercept swaps: ${anomalous.length}`);
  for (const a of anomalous.slice(0, 20)) {
    console.log(`  token ${a.token}  hook ${a.hook}  perms 0x${a.perms.toString(16)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
