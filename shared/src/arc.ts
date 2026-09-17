/**
 * Arc mainnet constants.
 *
 * Every address here was verified by direct RPC call on 2026-09-17, not copied
 * from another chain. See ARC-FINDINGS.md for how, and for the traps.
 */
import { defineChain } from 'viem';

export const ARC_CHAIN_ID = 5042;

/**
 * Arc is not in viem/chains — it must be defined manually.
 *
 * Note `nativeCurrency` is USDC with 18 decimals: that is the *internal* gas
 * accounting precision. The ERC-20 interface at USDC_ADDRESS exposes 6 decimals.
 * Both refer to the same balance. Do not mix the two when formatting.
 */
export const arc = defineChain({
  id: ARC_CHAIN_ID,
  name: 'Arc',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.arc.io'] },
  },
  blockExplorers: {
    // Permissioned — not publicly browsable. Address lookups go via RPC.
    default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' },
  },
});

// ─── Core ────────────────────────────────────────────────────────────────────

/**
 * USDC. Simultaneously the native gas token and an ERC-20.
 *
 * Overriding an address's *native* balance in an eth_call state override also
 * changes what balanceOf() returns here. That is how the Simulator is funded.
 *
 * This is also the address that appears in Uniswap v4 PoolKeys — NOT
 * address(0), despite USDC being the native asset. Confirmed across 130,462 pools.
 */
export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as const;

export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;
export const CREATE2_FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C' as const;

// ─── Uniswap v4 — the only DEX on Arc ────────────────────────────────────────
//
// There is no v2 or v3 deployment. The canonical v2/v3 addresses from other
// chains DO hold code on Arc, but it is unrelated Solidity 0.4-era bytecode
// that returns empty data for every Uniswap method. A `getCode() != "0x"`
// liveness check passes and then every call silently returns nothing.
// Never probe for a contract by bytecode presence alone.

export const V4_POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951' as const;
export const V4_POSITION_MANAGER = '0x6049c9a0e26405C0985f9E3685C87d0aE917f82B' as const;
export const V4_QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94' as const;
export const UNIVERSAL_ROUTER = '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1' as const;

/** keccak256("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)") */
export const V4_INITIALIZE_TOPIC =
  '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438' as const;

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

/** v4's dynamic-fee sentinel. Such a pool's fee can change between quote and trade. */
export const DYNAMIC_FEE_FLAG = 0x800000;

// ─── Protocol quirks that cause silent failures ──────────────────────────────

/**
 * Arc's minimum base fee is 20 Gwei and transactions below it are dropped by
 * the mempool with NO error and NO receipt. This presents as a hang, not a
 * failure. Assert this floor before sending anything.
 */
export const MIN_BASE_FEE_WEI = 20_000_000_000n;

/**
 * eth_getLogs returns at most 2000 results. Exceeding it yields -32602 with a
 * suggested narrower range in the error message — parse and follow it, but
 * clamp the suggestion against a freshly read head. The hint is computed
 * against the node's head at error time, so a reused hint can point PAST head
 * and come back -32014 "requested data not available", which looks like missing
 * history and is not. Deep history works fine.
 */
export const MAX_LOG_RESULTS = 2000;

/** ~40 blocks yields under 2000 results at observed activity. Adapt at runtime. */
export const INITIAL_LOG_CHUNK_BLOCKS = 40;

/**
 * Arc forbids transfers to address(0) at protocol level, so only this address
 * can actually accumulate burned tokens.
 */
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const;

/**
 * Block timestamps are non-decreasing but NOT strictly increasing — sub-second
 * blocks can share one. Derive age and ordering from block numbers.
 */
export const TIMESTAMPS_ARE_MONOTONIC = false;
