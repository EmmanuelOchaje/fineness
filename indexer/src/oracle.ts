/**
 * Calling the oracle.
 *
 * This is the production path, and it is the same call `verify-live` makes:
 * `eth_call` with state overrides. Two modes —
 *
 *   deployed  : Fineness exists on-chain; override only the Simulator's balance
 *   injected  : neither is deployed; override `code` for both plus balance
 *
 * The injected mode is why the contracts use `constant` rather than `immutable`
 * chain addresses. It means the oracle can be exercised against live mainnet
 * before a single wei of gas is spent, which is also the only way to test the
 * round trip at all — Foundry's forked REVM cannot execute Arc's native-backed
 * USDC (see ARC-FINDINGS.md).
 */
import { readFileSync } from 'node:fs';
import { decodeAbiParameters, encodeFunctionData } from 'viem';
import type { ArcRpc } from './rpc.js';
import type { DiscoveredPool } from './pools.js';

/**
 * Market cap in USD, derived from the probe.
 *
 * The simulator bought with `usdcProbed` and received `tokensOut`, so the
 * realised price is usdcProbed/tokensOut — an execution price against real
 * liquidity, not a quoted mid. Times total supply gives market cap.
 *
 * This number exists to gate the INSUFFICIENT_DATA rule on holder
 * concentration. Returns null when it cannot be computed, and null must be
 * treated as "unknown", never as zero.
 */
export function marketCapUsd(
  usdcProbed: bigint,
  tokensOut: bigint,
  totalSupply: bigint,
): number | null {
  if (tokensOut === 0n || totalSupply === 0n) return null;
  // usdcProbed is 6dp. Scale before dividing to keep precision.
  const capMicro = (usdcProbed * totalSupply) / tokensOut;
  return Number(capMicro) / 1e6;
}

/** Deterministic CREATE2 address, salt keccak256("fineness.simulator.v1"). */
export const SIMULATOR_ADDRESS = '0x880067680E32b27644ea82B62969eF074Fd85093';

/** Arbitrary address used only when injecting an undeployed Fineness. */
export const INJECTED_FINENESS = '0x00000000000000000000000000000000F19e5555';

/** 100 USDC, expressed in Arc's 18-decimal internal gas precision. */
const SIMULATOR_FUNDING = '0x56bc75e2d63100000';

export const REPORT_TUPLE = [
  {
    type: 'tuple',
    components: [
      { name: 'token', type: 'address' },
      { name: 'isHoneypot', type: 'bool' },
      { name: 'score', type: 'uint16' },
      { name: 'buyTaxBps', type: 'uint16' },
      { name: 'sellTaxBps', type: 'uint16' },
      { name: 'roundTripLossBps', type: 'uint16' },
      { name: 'usdcProbed', type: 'uint256' },
      { name: 'tokensOut', type: 'uint256' },
      { name: 'poolFeeBps', type: 'uint16' },
      { name: 'hookFeeBps', type: 'uint16' },
      { name: 'hasOwnerFunction', type: 'bool' },
      { name: 'ownershipRenounced', type: 'bool' },
      { name: 'mayBeUpgradeable', type: 'bool' },
      { name: 'hook', type: 'address' },
      { name: 'hookPermissions', type: 'uint16' },
      { name: 'hookBeyondBaseline', type: 'uint16' },
      { name: 'hookMatchesBaseline', type: 'bool' },
      { name: 'hookCanInterceptSwap', type: 'bool' },
      { name: 'hookTakesSwapFee', type: 'bool' },
      { name: 'dynamicFee', type: 'bool' },
      { name: 'flags', type: 'string[]' },
    ],
  },
] as const;

const CHECK_ABI = [
  {
    name: 'check',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'key',
        type: 'tuple',
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ],
      },
      { name: 'usdcAmount', type: 'uint256' },
    ],
    outputs: REPORT_TUPLE as never,
  },
] as const;

export interface OracleReport {
  token: string;
  isHoneypot: boolean;
  score: number;
  buyTaxBps: number;
  sellTaxBps: number;
  roundTripLossBps: number;
  usdcProbed: bigint;
  tokensOut: bigint;
  poolFeeBps: number;
  hookFeeBps: number;
  hasOwnerFunction: boolean;
  ownershipRenounced: boolean;
  mayBeUpgradeable: boolean;
  hook: string;
  hookPermissions: number;
  hookBeyondBaseline: number;
  hookMatchesBaseline: boolean;
  hookCanInterceptSwap: boolean;
  hookTakesSwapFee: boolean;
  dynamicFee: boolean;
  flags: string[];
}

export interface OracleOptions {
  /** Deployed Fineness address. Omit to inject the compiled bytecode instead. */
  finenessAddress?: string;
  /** Required when injecting. Paths to Foundry artifacts. */
  artifacts?: { fineness: URL; simulator: URL };
  /** Probe size in USDC (6dp). 1 USDC by default. */
  probeAmount?: bigint;
}

export class Oracle {
  private readonly rpc: ArcRpc;
  private readonly opts: OracleOptions;
  private code: { fineness: string; simulator: string } | null = null;

  constructor(rpc: ArcRpc, opts: OracleOptions = {}) {
    this.rpc = rpc;
    this.opts = opts;
    if (!opts.finenessAddress) {
      if (!opts.artifacts) {
        throw new Error('Oracle needs either a deployed address or compiled artifacts');
      }
      this.code = {
        fineness: readArtifact(opts.artifacts.fineness),
        simulator: readArtifact(opts.artifacts.simulator),
      };
    }
  }

  async check(pool: DiscoveredPool): Promise<OracleReport> {
    if (!pool.token) throw new Error('Pool contains no USDC and cannot be assayed');

    const target = this.opts.finenessAddress ?? INJECTED_FINENESS;
    const data = encodeFunctionData({
      abi: CHECK_ABI,
      functionName: 'check',
      args: [
        {
          currency0: pool.currency0,
          currency1: pool.currency1,
          fee: pool.fee,
          tickSpacing: pool.tickSpacing,
          hooks: pool.hooks,
        } as never,
        this.opts.probeAmount ?? 1_000_000n,
      ],
    });

    const overrides: Record<string, Record<string, string>> = {
      [SIMULATOR_ADDRESS]: { balance: SIMULATOR_FUNDING },
    };
    if (this.code) {
      overrides[SIMULATOR_ADDRESS]!.code = this.code.simulator;
      overrides[target] = { code: this.code.fineness };
    }

    const raw = await this.rpc.call<string>('eth_call', [
      { to: target, data, gas: '0x2000000' },
      'latest',
      overrides,
    ]);

    const [rep] = decodeAbiParameters(REPORT_TUPLE as never, raw as `0x${string}`) as [
      Record<string, unknown>,
    ];

    return {
      ...(rep as unknown as OracleReport),
      // uint16 values decode as numbers already, but flags need a plain copy.
      flags: [...((rep.flags as string[]) ?? [])],
    };
  }
}

function readArtifact(url: URL): string {
  const a = JSON.parse(readFileSync(url, 'utf8')) as { deployedBytecode: { object: string } };
  return a.deployedBytecode.object;
}
