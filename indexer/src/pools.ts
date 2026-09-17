/**
 * Pool discovery on Uniswap v4.
 *
 * v4 is a singleton — there is no factory and no `PairCreated`. Every pool on
 * Arc is born from an `Initialize` event on the one PoolManager, which carries
 * the entire PoolKey. That is convenient: discovering a pool and knowing how to
 * trade against it are the same operation.
 */
import { decodeAbiParameters, type Address } from 'viem';
import {
  V4_POOL_MANAGER,
  V4_INITIALIZE_TOPIC,
  USDC_ADDRESS,
  DYNAMIC_FEE_FLAG,
} from '@fineness/shared';
import { scanLogs } from './logs.js';
import type { ArcRpc, RawLog } from './rpc.js';

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface DiscoveredPool extends PoolKey {
  poolId: string;
  blockNumber: bigint;
  /** The non-USDC side, or null for a token/token pool we cannot assay. */
  token: Address | null;
  /** True when USDC is currency0 — determines swap direction. */
  usdcIsCurrency0: boolean;
  hasDynamicFee: boolean;
}

/**
 * Initialize(
 *   PoolId indexed id, Currency indexed currency0, Currency indexed currency1,
 *   uint24 fee, int24 tickSpacing, IHooks hooks, uint160 sqrtPriceX96, int24 tick
 * )
 *
 * currency0/currency1 are indexed, so they arrive as topics; the rest is packed
 * into `data`.
 */
const INITIALIZE_DATA_ABI = [
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
  { name: 'sqrtPriceX96', type: 'uint160' },
  { name: 'tick', type: 'int24' },
] as const;

export function decodeInitialize(log: RawLog): DiscoveredPool {
  const [, poolId, t1, t2] = log.topics;
  if (!poolId || !t1 || !t2) throw new Error('malformed Initialize log');

  const currency0 = `0x${t1.slice(-40)}`.toLowerCase() as Address;
  const currency1 = `0x${t2.slice(-40)}`.toLowerCase() as Address;

  const decoded = decodeAbiParameters(INITIALIZE_DATA_ABI, log.data as `0x${string}`);
  const fee = decoded[0] as number;
  const tickSpacing = decoded[1] as number;
  const hooks = decoded[2] as Address;

  const usdc = USDC_ADDRESS.toLowerCase();
  const usdcIsCurrency0 = currency0 === usdc;
  const hasUsdc = usdcIsCurrency0 || currency1 === usdc;

  return {
    poolId,
    currency0,
    currency1,
    fee,
    tickSpacing,
    hooks: hooks.toLowerCase() as Address,
    blockNumber: BigInt(log.blockNumber),
    // ~6% of Arc pools are token/token and carry no USDC at all. They are
    // discoverable but not assayable without multi-hop routing, which is out of
    // scope — surfaced as null rather than silently dropped.
    token: hasUsdc ? ((usdcIsCurrency0 ? currency1 : currency0) as Address) : null,
    usdcIsCurrency0,
    hasDynamicFee: fee === DYNAMIC_FEE_FLAG,
  };
}

export async function discoverPools(
  rpc: ArcRpc,
  fromBlock: bigint,
  toBlock: bigint,
  onPool?: (pool: DiscoveredPool) => void,
  onProgress?: (from: bigint, to: bigint, found: number) => void,
): Promise<DiscoveredPool[]> {
  const pools: DiscoveredPool[] = [];

  await scanLogs(rpc, {
    address: V4_POOL_MANAGER,
    topics: [V4_INITIALIZE_TOPIC],
    fromBlock,
    toBlock,
    onProgress: onProgress ?? undefined,
    onLogs: (logs) => {
      for (const log of logs) {
        try {
          const pool = decodeInitialize(log);
          pools.push(pool);
          onPool?.(pool);
        } catch {
          // A malformed log should not abort a multi-hour backfill.
        }
      }
    },
  });

  return pools;
}
