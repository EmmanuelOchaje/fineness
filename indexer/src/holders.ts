/**
 * Holder concentration.
 *
 * ERC-20 has no holder enumeration — there is no `holders()` to call, at any
 * price. The only way to know who holds what is to replay every Transfer log
 * from the token's birth and fold them into a balance map. That is why this
 * runs off-chain and the oracle does not attempt it.
 *
 * ## Why the verdict is market-cap aware
 *
 * A flat "top 10 hold >20% is bad" rule flags almost every honest launch. Four
 * minutes after a pool opens, the early buyers ARE the holders; distribution has
 * not happened yet. Applying a mature-token threshold to a newborn token
 * produces a confident-looking false positive, which is worse than silence.
 *
 * So below a floor we return INSUFFICIENT_DATA and show the raw number without a
 * verdict. "We could not judge this yet" and "we judged this and it is fine" are
 * different statements, and collapsing them is exactly where a trader gets hurt.
 */
import { getAddress, type Address } from 'viem';
import { TRANSFER_TOPIC, V4_POOL_MANAGER, BURN_ADDRESS } from '@fineness/shared';
import { scanLogs } from './logs.js';
import type { ArcRpc } from './rpc.js';

export type ConcentrationVerdict = 'PASS' | 'WARN' | 'FAIL' | 'INSUFFICIENT_DATA';

export interface HolderSnapshot {
  token: Address;
  holderCount: number;
  circulatingSupply: bigint;
  top10Share: number; // percent
  top10: { address: Address; balance: bigint; share: number }[];
  verdict: ConcentrationVerdict;
  reason: string;
  fromBlock: bigint;
  toBlock: bigint;
}

/** Thresholds live here, not inline, because they are tuning not truth. */
export const CONCENTRATION_CONFIG = {
  /** Below this market cap, concentration cannot be honestly judged. */
  insufficientDataBelowUsd: 15_000,
  /** Mature threshold, approached as market cap grows. */
  matureThresholdPct: 20,
  /** Loosest threshold applied just above the floor. */
  youngThresholdPct: 60,
  /** Market cap at which the mature threshold applies in full. */
  matureAtUsd: 250_000,
  warnMarginPct: 10,
} as const;

/**
 * Scale the threshold with market cap. A $20k token is judged gently, a $250k
 * token strictly, and nothing below the floor is judged at all.
 */
export function thresholdFor(marketCapUsd: number): number {
  const c = CONCENTRATION_CONFIG;
  if (marketCapUsd >= c.matureAtUsd) return c.matureThresholdPct;
  const span = c.matureAtUsd - c.insufficientDataBelowUsd;
  const progress = (marketCapUsd - c.insufficientDataBelowUsd) / span;
  return c.youngThresholdPct - progress * (c.youngThresholdPct - c.matureThresholdPct);
}

export function verdictFor(
  top10Share: number,
  marketCapUsd: number,
): { verdict: ConcentrationVerdict; reason: string } {
  if (marketCapUsd < CONCENTRATION_CONFIG.insufficientDataBelowUsd) {
    return {
      verdict: 'INSUFFICIENT_DATA',
      reason:
        `Market cap under $${CONCENTRATION_CONFIG.insufficientDataBelowUsd.toLocaleString()}. ` +
        'A token this young is naturally concentrated — too early to assay.',
    };
  }

  const threshold = thresholdFor(marketCapUsd);
  if (top10Share <= threshold - CONCENTRATION_CONFIG.warnMarginPct) {
    return { verdict: 'PASS', reason: `Top 10 hold ${top10Share.toFixed(1)}%, under the ${threshold.toFixed(0)}% threshold.` };
  }
  if (top10Share <= threshold) {
    return { verdict: 'WARN', reason: `Top 10 hold ${top10Share.toFixed(1)}%, close to the ${threshold.toFixed(0)}% threshold.` };
  }
  return { verdict: 'FAIL', reason: `Top 10 hold ${top10Share.toFixed(1)}%, above the ${threshold.toFixed(0)}% threshold.` };
}

/**
 * Addresses that hold tokens but are not holders in any meaningful sense.
 *
 * On v4 this is a single address for the entire chain: all liquidity across
 * every pool lives in the one PoolManager singleton. Miss it and the pool
 * dominates the top-10 of literally every token.
 */
function excludedAddresses(): Set<string> {
  return new Set([
    V4_POOL_MANAGER.toLowerCase(),
    BURN_ADDRESS.toLowerCase(),
    '0x0000000000000000000000000000000000000000',
  ]);
}

export async function buildHolderSnapshot(
  rpc: ArcRpc,
  token: Address,
  fromBlock: bigint,
  toBlock: bigint,
  marketCapUsd: number,
): Promise<HolderSnapshot> {
  const balances = new Map<string, bigint>();
  const excluded = excludedAddresses();

  await scanLogs(rpc, {
    address: token,
    topics: [TRANSFER_TOPIC],
    fromBlock,
    toBlock,
    onLogs: (logs) => {
      for (const log of logs) {
        // Transfer(address indexed from, address indexed to, uint256 value)
        const [, fromTopic, toTopic] = log.topics;
        if (!fromTopic || !toTopic) continue; // ERC-721 style, or malformed

        const from = `0x${fromTopic.slice(-40)}`.toLowerCase();
        const to = `0x${toTopic.slice(-40)}`.toLowerCase();
        const value = BigInt(log.data === '0x' ? '0x0' : log.data.slice(0, 66));

        if (value === 0n) continue;
        balances.set(from, (balances.get(from) ?? 0n) - value);
        balances.set(to, (balances.get(to) ?? 0n) + value);
      }
    },
  });

  let circulating = 0n;
  const holders: { address: Address; balance: bigint }[] = [];
  for (const [addr, bal] of balances) {
    if (bal <= 0n) continue;
    circulating += bal;
    if (excluded.has(addr)) continue;
    holders.push({ address: getAddress(addr), balance: bal });
  }

  holders.sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
  const top = holders.slice(0, 10);

  // Denominator is circulating supply INCLUDING the pool: the pool's tokens are
  // genuinely outstanding and can be sold into the market. Excluding it from the
  // numerator but not the denominator is the honest combination.
  const topSum = top.reduce((s, h) => s + h.balance, 0n);
  const top10Share =
    circulating > 0n ? Number((topSum * 10_000n) / circulating) / 100 : 0;

  const { verdict, reason } = verdictFor(top10Share, marketCapUsd);

  return {
    token,
    holderCount: holders.length,
    circulatingSupply: circulating,
    top10Share,
    top10: top.map((h) => ({
      ...h,
      share: circulating > 0n ? Number((h.balance * 10_000n) / circulating) / 100 : 0,
    })),
    verdict,
    reason,
    fromBlock,
    toBlock,
  };
}
