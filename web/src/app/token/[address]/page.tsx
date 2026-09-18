/**
 * The assay report.
 *
 * The central design requirement: a viewer glancing for one second must know
 * which half is verified and which is merely noted. That separation is carried
 * by weight and structure, not by a label people have to read —
 *
 *   Verified  — struck hallmark, hard rules, monospace values, pass/fail colour
 *   Context   — no badges, no colour, lighter ink, and a visible left margin
 *               rule that stops it aligning with the verified column
 *
 * If those two sections ever look interchangeable, the product has failed at
 * the thing it exists to do.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getReport } from '@/lib/api';
import { assay, statusColor } from '@/lib/assay';
import { Hallmark, markColor } from '@/components/Hallmark';
import { BuyPanel } from '@/components/BuyPanel';

export const dynamic = 'force-dynamic';

export default async function ReportPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  const report = await getReport(address);
  if (!report) notFound();

  const a = assay(report);
  const v = report.verified;
  const color = markColor(a.early ? null : report.score, a.hardFail);

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', minHeight: '100vh' }}>
      <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--rule)' }}>
        <Link href="/" className="label" style={{ color: 'var(--muted)' }}>
          ← Newly struck
        </Link>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch' }}>
        <div
          style={{
            flex: '1 1 520px',
            minWidth: 0,
            borderRight: '1px solid var(--rule)',
            paddingBottom: 80,
          }}
        >
          {/* ---- the mark ---- */}
          <header
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              flexWrap: 'wrap',
              gap: '28px 34px',
              padding: '34px 34px 30px',
              borderBottom: '1px solid var(--rule)',
            }}
          >
            <Hallmark
              size="report"
              mark={a.mark ?? undefined}
              state={a.mark ? 'struck' : 'unstruck'}
              color={color}
            />
            <div style={{ minWidth: 0, flex: '1 1 240px' }}>
              <div className="label">Assay report</div>

              {/* Identity is deployer-supplied, so it sits here as a label on
                  the report — never as part of the evidence below. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
                {report.logo && (
                  <img
                    src={report.logo}
                    alt=""
                    width={34}
                    height={34}
                    style={{
                      width: 34,
                      height: 34,
                      objectFit: 'cover',
                      border: '1px solid var(--rule)',
                      background: 'var(--well)',
                      flex: 'none',
                    }}
                  />
                )}
                <div style={{ minWidth: 0 }}>
                  <div className="serif" style={{ fontSize: 24 }}>
                    {report.name ?? 'Unnamed token'}
                  </div>
                  {report.symbol && (
                    <div className="mono" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                      {report.symbol}
                    </div>
                  )}
                </div>
              </div>

              <div
                className="mono"
                style={{
                  fontSize: 12,
                  marginTop: 12,
                  wordBreak: 'break-all',
                  lineHeight: 1.5,
                  color: 'var(--faint)',
                }}
              >
                {report.token}
              </div>
              <div style={{ marginTop: 16, display: 'flex', gap: 26, flexWrap: 'wrap' }}>
                <Stat
                  label="Market cap"
                  value={
                    report.marketCap === null
                      ? '—'
                      : `$${report.marketCap.toLocaleString('en-US', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}`
                  }
                />
                <Stat label="Passed" value={`${a.passes} of ${a.checks.length}`} />
                <Stat
                  label="Token tax"
                  value={`${v.tokenTax.buyBps + v.tokenTax.sellBps} bps`}
                />
                <Stat
                  label="Venue fee"
                  value={`${v.venueFee.poolBps + v.venueFee.hookBps} bps`}
                  dim
                />
              </div>

              {a.early && (
                <p
                  style={{
                    marginTop: 18,
                    fontSize: 13,
                    color: 'var(--early)',
                    lineHeight: 1.6,
                    maxWidth: 460,
                  }}
                >
                  No mark struck. This token is too young to assay honestly — the
                  deterministic checks below still hold.
                </p>
              )}
            </div>
          </header>

          {/* ---- VERIFIED ---- */}
          <section>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 12,
                padding: '24px 34px 14px',
              }}
            >
              <h2 className="serif" style={{ fontSize: 26, fontWeight: 400 }}>
                Verified
              </h2>
              <span className="label" style={{ color: 'var(--faint)' }}>
                Executed on-chain · cannot be faked by the deployer
              </span>
            </div>

            {a.checks.map((c) => (
              <div
                key={c.label}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0,1fr) 150px 92px',
                  gap: 16,
                  alignItems: 'start',
                  padding: '16px 34px',
                  borderTop: '1px solid var(--rule-soft)',
                }}
              >
                <div>
                  <div
                    className="mono"
                    style={{ fontSize: 11, letterSpacing: '0.16em', color: 'var(--ink)' }}
                  >
                    {c.label}
                  </div>
                  <p
                    style={{
                      marginTop: 7,
                      fontSize: 12.5,
                      lineHeight: 1.6,
                      color: 'var(--faint)',
                      maxWidth: 520,
                    }}
                  >
                    {c.note}
                  </p>
                </div>
                <div
                  className="mono"
                  style={{ fontSize: 13, textAlign: 'right', color: 'var(--dim)' }}
                >
                  {c.value}
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 10.5,
                    letterSpacing: '0.15em',
                    textAlign: 'right',
                    color: statusColor(c.status),
                  }}
                >
                  {c.status}
                </div>
              </div>
            ))}

            {/* Fee breakdown. Three numbers, never one — see Fineness.sol. */}
            <div
              style={{
                margin: '26px 34px 0',
                padding: '16px 18px',
                background: 'var(--panel-alt)',
                border: '1px solid var(--rule)',
              }}
            >
              <div className="label" style={{ marginBottom: 12 }}>
                Round-trip cost, decomposed
              </div>
              <FeeRow label="Token transfer tax" bps={v.tokenTax.buyBps + v.tokenTax.sellBps} emphasis />
              <FeeRow label="Pool fee (both legs)" bps={v.venueFee.poolBps} />
              <FeeRow label="Launchpad hook fee" bps={v.venueFee.hookBps} />
              <p
                style={{
                  marginTop: 12,
                  fontSize: 12,
                  color: 'var(--faint)',
                  lineHeight: 1.6,
                }}
              >
                Only the first line is the token&apos;s own behaviour. The other two are
                what the venue charges everyone — about 91% of Arc pools run a
                fee-taking hook.
              </p>
            </div>
          </section>

          {/* ---- CONTEXT ---- */}
          <section style={{ marginTop: 44, padding: '0 34px' }}>
            <div
              style={{
                borderLeft: '1px solid var(--rule)',
                paddingLeft: 20,
                // Deliberately indented and unaligned with Verified above, so
                // the eye reads it as an aside rather than as more evidence.
                opacity: 0.86,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                <h2
                  className="serif"
                  style={{ fontSize: 22, fontWeight: 400, color: 'var(--dim)' }}
                >
                  Context
                </h2>
                <span className="label" style={{ color: 'var(--faint)' }}>
                  Noted, not certified · never scored
                </span>
              </div>

              <p
                style={{
                  marginTop: 12,
                  fontSize: 12.5,
                  lineHeight: 1.7,
                  color: 'var(--faint)',
                  maxWidth: 560,
                }}
              >
                Socials, description, X account age and the deployer&apos;s previous
                launches belong here. They are shown so you have everything on one
                screen — and deliberately excluded from the mark, because a deployer
                can fabricate all of them in an afternoon.
              </p>

              <div
                className="mono"
                style={{ marginTop: 16, fontSize: 12, color: 'var(--faint)', lineHeight: 2 }}
              >
                <div>POOL &nbsp;{report.pool.poolId.slice(0, 18)}…</div>
                <div>HOOK &nbsp;{v.hook.address}</div>
                <div>PERMS {v.hook.permissions} · {v.hook.granted.join(' | ') || 'none'}</div>
                <div>BLOCK {report.pool.initBlock}</div>
              </div>

              {!report.context.available && (
                <div
                  className="label"
                  style={{ marginTop: 18, color: 'var(--faint)' }}
                >
                  Social context unavailable — the report is complete without it
                </div>
              )}
            </div>
          </section>
        </div>

        <BuyPanel
          token={report.token}
          isHoneypot={v.isHoneypot}
          score={report.score}
          early={a.early}
          blockingFlag={
            v.isHoneypot
              ? 'This token cannot be sold. A simulated sell reverted against current state.'
              : null
          }
        />
      </div>
    </main>
  );
}

function Stat({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div>
      <div className="label" style={{ fontSize: 9.5 }}>
        {label}
      </div>
      <div
        className="mono"
        style={{ fontSize: 15, marginTop: 5, color: dim ? 'var(--faint)' : 'var(--ink)' }}
      >
        {value}
      </div>
    </div>
  );
}

function FeeRow({ label, bps, emphasis }: { label: string; bps: number; emphasis?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        padding: '5px 0',
      }}
    >
      <span style={{ fontSize: 12.5, color: emphasis ? 'var(--ink)' : 'var(--faint)' }}>
        {label}
      </span>
      <span
        className="mono"
        style={{
          fontSize: 13,
          color: emphasis && bps > 300 ? 'var(--fail)' : emphasis ? 'var(--ink)' : 'var(--faint)',
        }}
      >
        {bps} bps
      </span>
    </div>
  );
}
