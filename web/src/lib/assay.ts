/**
 * Turning an API report into the six checks the assay report displays.
 *
 * ## One deliberate change from the mockup
 *
 * The mockup's sixth check is LP BURNED — "LP tokens sent to a burn address".
 * That check cannot exist on Arc. Uniswap v4 has no LP ERC-20 to burn; liquidity
 * is an ERC-721 position in PositionManager, and Arc forbids transfers to the
 * zero address so only 0x…dead is even a usable sink. The mockup was drawn
 * before the chain was surveyed.
 *
 * Its slot is taken by HOOK PERMISSIONS, which is the check that actually
 * distinguishes this product. The visual treatment is identical — same row,
 * same pass/fail language — so the report reads exactly as designed.
 *
 * ## Why the wording is careful
 *
 * ~91% of Arc pools carry a hook and ~5.4% hold BEFORE_SWAP. Those numbers are
 * far too large for accusatory copy. A hook that COULD block a sell, on a token
 * whose sell simulation just succeeded, is a capability worth stating — not
 * evidence of fraud. The notes say so.
 */

export interface ApiReport {
  token: string;
  mark: string;
  score: number;
  verified: {
    isHoneypot: boolean;
    tokenTax: { buyBps: number; sellBps: number };
    venueFee: { poolBps: number; hookBps: number };
    authority: { ownershipRenounced: boolean; mayBeUpgradeable: boolean; note: string };
    hook: {
      address: string;
      permissions: string;
      granted: string[];
      matchesEcosystemBaseline: boolean;
      canInterceptSwap: boolean;
      note: string;
    };
    dynamicFee: boolean;
    concentration: { top10Share?: number; verdict: string; reason: string };
    flags: string[];
    checkedAt: number;
  };
  context: { available: boolean; note: string };
  pool: { poolId: string; fee: number; usdcIsCurrency0: boolean; initBlock: number };
}

/**
 * Five states, and the last two are NOT the same thing.
 *
 *   TOO EARLY  — we looked; the token is too young to judge honestly
 *   NOT RUN    — we have not looked yet
 *
 * The design brief calls this the hardest and most important visual in the
 * product: most tools collapse "we checked and it's fine" into "we couldn't
 * check", and that gap is exactly where a trader gets hurt. Rendering a
 * pending scan as "too early" would be the same lie in a different direction.
 */
export type Status = 'PASS' | 'FAIL' | 'TOO EARLY' | 'NOT RUN';

export interface Check {
  label: string;
  value: string;
  status: Status;
  ok: boolean | null;
  note: string;
}

/** Tax threshold in bps, matching the mockup. */
const TAX_LIMIT = 300;

export function buildChecks(r: ApiReport): Check[] {
  const v = r.verified;
  const { buyBps, sellBps } = v.tokenTax;
  const taxOk = buyBps <= TAX_LIMIT && sellBps <= TAX_LIMIT;
  const conc = v.concentration;
  const early = conc.verdict === 'INSUFFICIENT_DATA';
  const notRun = conc.verdict === 'NOT_COMPUTED';

  return [
    {
      label: 'HONEYPOT SIMULATION',
      value: v.isHoneypot ? 'SELL REVERTS' : 'SELL SUCCEEDS',
      status: v.isHoneypot ? 'FAIL' : 'PASS',
      ok: !v.isHoneypot,
      note: v.isHoneypot
        ? 'A simulated sell reverted. Tokens bought cannot be sold back to the pool.'
        : 'A buy and an immediate sell were executed against current state. Both succeeded.',
    },
    {
      label: 'TRANSFER TAX',
      value: `${buyBps} / ${sellBps} bps`,
      status: taxOk ? 'PASS' : 'FAIL',
      ok: taxOk,
      note: taxOk
        ? `Buy and sell tax both at or below the ${TAX_LIMIT} bps threshold. This is the token's own tax, measured — the venue's fee is reported separately.`
        : `Tax exceeds ${TAX_LIMIT} bps on at least one side. Exit costs more than the threshold allows.`,
    },
    {
      label: 'OWNERSHIP',
      value: v.authority.ownershipRenounced ? 'RENOUNCED' : 'RETAINED',
      status: v.authority.ownershipRenounced ? 'PASS' : 'FAIL',
      ok: v.authority.ownershipRenounced,
      note: v.authority.ownershipRenounced
        ? 'Owner set to the zero address. Privileged functions are permanently unreachable.'
        : 'An address still holds owner privileges and can change token behaviour after you buy.',
    },
    {
      label: 'PROXY ADMIN',
      value: v.authority.mayBeUpgradeable ? 'MAY UPGRADE' : 'NO DELEGATECALL',
      status: v.authority.mayBeUpgradeable ? 'FAIL' : 'PASS',
      ok: !v.authority.mayBeUpgradeable,
      note: v.authority.mayBeUpgradeable
        ? 'Bytecode contains DELEGATECALL, so the implementation may be replaceable. The admin slot itself is read off-chain — a contract cannot read another contract’s storage.'
        : 'No DELEGATECALL in the bytecode. This contract cannot be an upgradeable proxy.',
    },
    {
      // Replaces the mockup's LP BURNED slot. See the note at the top.
      label: 'POOL HOOK',
      value: v.hook.canInterceptSwap
        ? 'CAN INTERCEPT'
        : v.hook.matchesEcosystemBaseline
          ? 'STANDARD'
          : v.hook.permissions === '0x0000'
            ? 'NONE'
            : 'NON-STANDARD',
      status: v.hook.canInterceptSwap ? 'FAIL' : 'PASS',
      ok: !v.hook.canInterceptSwap,
      note: v.hook.canInterceptSwap
        ? 'This pool’s hook holds permissions that let it block or reprice a sell before it executes. The sell simulation above still succeeded — this is capability, not proof.'
        : v.hook.matchesEcosystemBaseline
          ? 'Hook permissions match the Arc launchpad standard: it takes a fee after each swap and cannot intercept one. Normal for 94% of hooked pools.'
          : v.hook.permissions === '0x0000'
            ? 'No hook attached. Swaps execute against the pool directly.'
            : 'Hook permissions differ from the ecosystem norm, but none of them can affect a swap.',
    },
    notRun
      ? {
          label: 'HOLDER CONCENTRATION',
          value: 'NOT RUN',
          status: 'NOT RUN',
          ok: null,
          note: 'The holder index has not been built for this token yet. This is not a finding about the token — it is a gap in our data, and it is shown as one.',
        }
      : early
      ? {
          label: 'HOLDER CONCENTRATION',
          value: 'WITHHELD',
          status: 'TOO EARLY',
          ok: null,
          note: conc.reason,
        }
      : {
          label: 'HOLDER CONCENTRATION',
          value: `TOP 10 · ${(conc.top10Share ?? 0).toFixed(0)}%`,
          status: conc.verdict === 'FAIL' ? 'FAIL' : 'PASS',
          ok: conc.verdict !== 'FAIL',
          note: conc.reason,
        },
  ];
}

export interface Assay {
  checks: Check[];
  passes: number;
  early: boolean;
  hardFail: boolean;
  /** null when no mark can honestly be struck. */
  mark: string | null;
}

export function assay(r: ApiReport): Assay {
  const checks = buildChecks(r);
  const passes = checks.filter((c) => c.ok === true).length;
  const early = checks.some((c) => c.status === 'TOO EARLY');
  // A pending scan must not suppress the mark — that would punish the token for
  // our own incomplete data. Only a genuine "too early" withholds the mark.
  const hardFail = r.verified.isHoneypot;

  return {
    checks,
    passes,
    early,
    hardFail,
    // A honeypot is .000 regardless of what else passed — you cannot get out.
    // Otherwise, below the data floor no mark is struck at all.
    mark: hardFail ? '.000' : early ? null : `.${String(r.score).padStart(3, '0')}`,
  };
}

export function statusColor(s: Status): string {
  if (s === 'PASS') return 'var(--pass)';
  if (s === 'FAIL') return 'var(--fail)';
  if (s === 'TOO EARLY') return 'var(--early)';
  // NOT RUN is deliberately colourless. It carries no verdict, so it must not
  // borrow the visual weight of one.
  return 'var(--faint)';
}
