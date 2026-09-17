/**
 * Validate the Simulator against LIVE Arc mainnet — without deploying anything.
 *
 * ## Why this exists instead of a fork test
 *
 * Foundry's forked REVM cannot execute Arc's USDC. The token at 0x3600… is
 * native-backed at the protocol level, and in a fork every `transfer` reverts
 * silently — even to a plain EOA. On the real RPC the identical call returns
 * true. So `forge test --fork-url` can cover pure logic but CANNOT cover the
 * round trip, which is the part that matters.
 *
 * The real RPC can, because state overrides let us inject the Simulator's
 * bytecode at an address and fund it, all inside a single `eth_call`:
 *
 *   - `code`    override -> the Simulator exists for the duration of the call
 *   - `balance` override -> it holds USDC (native and ERC-20 are one balance)
 *
 * Nothing is deployed, nothing is spent, no key is needed. This is also exactly
 * how the API will call the oracle in production, so validating this way tests
 * the real path rather than an approximation of it.
 *
 *   pnpm --filter @fineness/indexer verify-live
 */
import { readFileSync } from 'node:fs';
import { decodeAbiParameters, encodeFunctionData, type Address } from 'viem';
import { analyzeHook, USDC_ADDRESS } from '@fineness/shared';
import { ArcRpc } from './rpc.js';

const SIMULATOR_ADDRESS = '0x880067680E32b27644ea82B62969eF074Fd85093' as const;
const ARTIFACT = new URL('../../contracts/out/Simulator.sol/Simulator.json', import.meta.url);
const FINENESS_ARTIFACT = new URL('../../contracts/out/Fineness.sol/Fineness.json', import.meta.url);
const FINENESS_ADDRESS = '0x00000000000000000000000000000000F19e5555' as const;

/** Pools with recent swap activity, from `find-pools`. Replace when they rot. */
const POOLS = [
  {
    label: 'hooked pool (baseline 0x2044)',
    token: '0x5c11D8B3d09EEFb2c3A8506082a5F1567Ada95fb',
    hooks: '0x69a79Ab259ea7Ef2e68F64c8fa2b1AD16723E044',
  },
  {
    label: 'unhooked pool (the ~9% case)',
    token: '0x5eec40846a60a476b6E87B0eEAf43F119A70dF2C',
    hooks: '0x0000000000000000000000000000000000000000',
  },
  {
    label: 'hooked pool #2',
    token: '0x676bE0ca09E177cb7FE64f3f616B03e8b4b3aA5c',
    hooks: '0x79b583C32e1b75982390cFAa0c975F6a4d87A044',
  },
] as const;

const SIM_RESULT_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'usdcSent', type: 'uint256' },
      { name: 'usdcCredited', type: 'uint256' },
      { name: 'tokensFromPool', type: 'uint256' },
      { name: 'tokensReceived', type: 'uint256' },
      { name: 'buySucceeded', type: 'bool' },
      { name: 'tokensSent', type: 'uint256' },
      { name: 'tokensCredited', type: 'uint256' },
      { name: 'usdcFromPool', type: 'uint256' },
      { name: 'usdcReceived', type: 'uint256' },
      { name: 'sellSucceeded', type: 'bool' },
      { name: 'failureReason', type: 'string' },
    ],
  },
] as const;

const SIMULATE_ABI = [
  {
    name: 'simulate',
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
    outputs: SIM_RESULT_ABI as never,
  },
] as const;

function sortKey(token: string, hooks: string) {
  const usdc = USDC_ADDRESS.toLowerCase();
  const t = token.toLowerCase();
  // v4 orders currencies by address; USDC sorts mid-range so this genuinely varies.
  const [currency0, currency1] = usdc < t ? [usdc, t] : [t, usdc];
  return { currency0, currency1, fee: 10000, tickSpacing: 200, hooks: hooks.toLowerCase() };
}

async function main() {
  const rpc = new ArcRpc({ url: process.env.ARC_RPC_URL ?? 'https://rpc.mainnet.arc.io' });

  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as {
    deployedBytecode: { object: string };
  };
  const runtimeCode = artifact.deployedBytecode.object;
  console.log(`Simulator runtime bytecode: ${(runtimeCode.length - 2) / 2} bytes`);
  console.log(`Injecting at ${SIMULATOR_ADDRESS} via eth_call state override\n`);

  let passed = 0;

  for (const pool of POOLS) {
    const key = sortKey(pool.token, pool.hooks);
    const a = analyzeHook(pool.hooks);

    console.log(`── ${pool.label}`);
    console.log(`   token ${pool.token}`);
    console.log(`   usdcIsCurrency0 ${key.currency0 === USDC_ADDRESS.toLowerCase()}`);
    console.log(`   hook perms 0x${a.permissions.toString(16)}  intercepts=${a.dangerous.length > 0}`);

    const data = encodeFunctionData({
      abi: SIMULATE_ABI,
      functionName: 'simulate',
      args: [key as never, 1_000_000n], // 1 USDC
    });

    try {
      const raw = await rpc.call<string>('eth_call', [
        { to: SIMULATOR_ADDRESS, data, gas: '0x2000000' },
        'latest',
        {
          [SIMULATOR_ADDRESS]: {
            code: runtimeCode,
            balance: '0x56bc75e2d63100000', // 100 USDC
          },
        },
      ]);

      const [r] = decodeAbiParameters(SIM_RESULT_ABI as never, raw as `0x${string}`) as [
        Record<string, bigint | boolean | string>,
      ];

      const usdcSent = r.usdcSent as bigint;
      const usdcBack = r.usdcReceived as bigint;
      const buyTax = bps(
        (r.tokensFromPool as bigint) - (r.tokensReceived as bigint),
        r.tokensFromPool as bigint,
      );
      const sellTax = bps(
        (r.tokensSent as bigint) - (r.tokensCredited as bigint),
        r.tokensSent as bigint,
      );
      const roundTrip = usdcSent > 0n ? bps(usdcSent - usdcBack, usdcSent) : 0;

      console.log(`   buy  : sent ${usdcSent} USDC -> ${r.tokensReceived} tokens`);
      console.log(`   sell : ok=${r.sellSucceeded} -> ${usdcBack} USDC back`);
      console.log(`   token tax: buy ${buyTax}bps  sell ${sellTax}bps`);
      console.log(`   round-trip loss: ${roundTrip}bps (venue fee ≈ ${roundTrip - buyTax - sellTax}bps)`);
      if (!r.sellSucceeded) console.log(`   ⚠️  HONEYPOT: ${r.failureReason}`);
      console.log('   ✅ simulation executed against live state\n');
      passed++;
    } catch (e) {
      console.log(`   ❌ ${(e as Error).message}\n`);
    }
  }

  console.log(`${passed}/${POOLS.length} pools simulated successfully.\n`);

  // ---- full oracle ---------------------------------------------------------
  // Inject BOTH contracts: Fineness at an arbitrary address, and Simulator at
  // the exact CREATE2 address Fineness references as a constant. This is the
  // complete production path — the API will make this identical call.
  console.log('── full Fineness.check() via double code override');
  const finenessArtifact = JSON.parse(readFileSync(FINENESS_ARTIFACT, 'utf8')) as {
    deployedBytecode: { object: string };
  };

  const pool = POOLS[0]!;
  const key = sortKey(pool.token, pool.hooks);
  const checkData = encodeFunctionData({
    abi: CHECK_ABI,
    functionName: 'check',
    args: [key as never, 1_000_000n],
  });

  try {
    const raw = await rpc.call<string>('eth_call', [
      { to: FINENESS_ADDRESS, data: checkData, gas: '0x2000000' },
      'latest',
      {
        [FINENESS_ADDRESS]: { code: finenessArtifact.deployedBytecode.object },
        [SIMULATOR_ADDRESS]: {
          code: runtimeCode,
          balance: '0x56bc75e2d63100000',
        },
      },
    ]);
    const [rep] = decodeAbiParameters(REPORT_ABI as never, raw as `0x${string}`) as [
      Record<string, never>,
    ];
    const g = (k: string) => (rep as Record<string, unknown>)[k];
    console.log(`   token             ${g('token')}`);
    console.log(`   score             ${g('score')} / 1000`);
    console.log(`   isHoneypot        ${g('isHoneypot')}`);
    console.log(`   buy/sell tax bps  ${g('buyTaxBps')} / ${g('sellTaxBps')}`);
    console.log(`   roundTripLossBps  ${g('roundTripLossBps')}`);
    console.log(`   poolFeeBps        ${g('poolFeeBps')}`);
    console.log(`   hookFeeBps        ${g('hookFeeBps')}`);
    console.log(`   hookPermissions   0x${(g('hookPermissions') as bigint).toString(16)}`);
    console.log(`   hookMatchesBase   ${g('hookMatchesBaseline')}`);
    console.log(`   ownershipRenounce ${g('ownershipRenounced')}`);
    console.log(`   mayBeUpgradeable  ${g('mayBeUpgradeable')}`);
    console.log(`   flags             ${JSON.stringify(g('flags'))}`);
    console.log('   ✅ full oracle ran against live mainnet state');
  } catch (e) {
    console.log(`   ❌ ${(e as Error).message}`);
    process.exit(1);
  }

  if (passed === 0) process.exit(1);
}

const REPORT_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'token', type: 'address' },
      { name: 'isHoneypot', type: 'bool' },
      { name: 'score', type: 'uint16' },
      { name: 'buyTaxBps', type: 'uint16' },
      { name: 'sellTaxBps', type: 'uint16' },
      { name: 'roundTripLossBps', type: 'uint16' },
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
    outputs: REPORT_ABI as never,
  },
] as const;

function bps(part: bigint, whole: bigint): number {
  if (whole === 0n) return 0;
  return Number((part * 10_000n) / whole);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
