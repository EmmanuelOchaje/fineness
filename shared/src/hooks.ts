/**
 * Uniswap v4 hook permission decoding.
 *
 * This is the product's differentiating check, so it lives in shared code and is
 * tested as a pure function. Read the reasoning before changing any constant.
 *
 * v4 encodes a hook's permissions in the LOW 14 BITS OF ITS OWN ADDRESS. A hook
 * contract can only be deployed at an address whose low bits match the callbacks
 * it implements — that is why v4 hook addresses look mined.
 *
 * On Arc this matters more than anywhere else: 91% of pools carry a hook and
 * there are 112,149 distinct hook addresses across 118,650 hooked pools — a fresh
 * hook per pool. So hook PRESENCE flags essentially the whole chain and proves
 * nothing, and address allowlisting is impossible because addresses are never
 * reused. The permissions are the signal.
 *
 * ⚠️ The bit positions below are derived from observed Arc addresses and the
 * public v4 layout. Confirm against v4-core Hooks.sol before relying on the
 * score in production.
 */

/** Bit positions within the low 14 bits of a hook address. */
export const HOOK_FLAGS = {
  AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA: 0,
  AFTER_ADD_LIQUIDITY_RETURNS_DELTA: 1,
  AFTER_SWAP_RETURNS_DELTA: 2,
  BEFORE_SWAP_RETURNS_DELTA: 3,
  AFTER_DONATE: 4,
  BEFORE_DONATE: 5,
  AFTER_SWAP: 6,
  BEFORE_SWAP: 7,
  AFTER_REMOVE_LIQUIDITY: 8,
  BEFORE_REMOVE_LIQUIDITY: 9,
  AFTER_ADD_LIQUIDITY: 10,
  BEFORE_ADD_LIQUIDITY: 11,
  AFTER_INITIALIZE: 12,
  BEFORE_INITIALIZE: 13,
} as const;

export type HookFlagName = keyof typeof HOOK_FLAGS;

export const HOOK_PERMISSION_MASK = 0x3fff;

/**
 * The Arc ecosystem baseline, measured across 130,462 live pools on 2026-09-17.
 *
 *   0x2044 = BEFORE_INITIALIZE | AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA
 *
 * That is a hook taking a cut of every swap — the standard launchpad pattern,
 * consistent with aka.fun's documented trading fee. It is NORMAL. A pool
 * matching this baseline must not lose score for it, or 91% of the chain gets
 * flagged and the mark becomes meaningless.
 *
 * ⚠️ This is an empirical observation from a chain days old, not a spec. If a
 * second launchpad ships with different permissions, this needs re-measuring.
 * Re-survey before submission.
 */
export const ARC_BASELINE_PERMISSIONS = 0x2044;

/**
 * Permissions that let a hook intercept a swap BEFORE it executes — i.e. block a
 * sell outright, or re-price it arbitrarily. The Arc baseline does NOT carry
 * these. A hook that does, when the ecosystem norm does not, is the strongest
 * deterministic honeypot signal available on v4.
 */
/**
 * Measured at full scale: 6,392 pools (~5.4% of hooked pools) carry BEFORE_SWAP.
 * That is a large population with legitimate uses (limit orders, dynamic
 * pricing), so this is a heavy risk signal, NOT proof of a honeypot. The
 * behavioural round trip is the proof. Treating 5% of a chain as guilty would
 * repeat the mistake this check exists to avoid.
 */
export const DANGEROUS_FLAGS: HookFlagName[] = [
  'BEFORE_SWAP',
  'BEFORE_SWAP_RETURNS_DELTA',
];

export interface HookAnalysis {
  /** The raw low-14-bit permission bitmap. */
  permissions: number;
  /** Every permission the hook declares. */
  granted: HookFlagName[];
  /** True when the hook address is zero — rare on Arc (~5% of pools). */
  isZeroHook: boolean;
  /** True when permissions exactly match the measured ecosystem baseline. */
  matchesBaseline: boolean;
  /** Permissions held beyond the baseline. */
  beyondBaseline: HookFlagName[];
  /** Subset of the above that can block or re-price a sell. The real signal. */
  dangerous: HookFlagName[];
}

/** Decode a hook address's declared permissions. Pure; no RPC, no deployment. */
export function analyzeHook(hookAddress: string): HookAnalysis {
  const addr = BigInt(hookAddress);
  const permissions = Number(addr & BigInt(HOOK_PERMISSION_MASK));
  const isZeroHook = addr === 0n;

  const granted = (Object.keys(HOOK_FLAGS) as HookFlagName[]).filter(
    (name) => (permissions >> HOOK_FLAGS[name]) & 1,
  );

  // A zero address is not a hook at all — it declares nothing.
  const effective = isZeroHook ? [] : granted;
  const beyondBaseline = effective.filter(
    (name) => !((ARC_BASELINE_PERMISSIONS >> HOOK_FLAGS[name]) & 1),
  );

  return {
    permissions: isZeroHook ? 0 : permissions,
    granted: effective,
    isZeroHook,
    matchesBaseline: !isZeroHook && permissions === ARC_BASELINE_PERMISSIONS,
    beyondBaseline,
    dangerous: beyondBaseline.filter((name) => DANGEROUS_FLAGS.includes(name)),
  };
}
