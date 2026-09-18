/**
 * The feed — "Newly struck".
 *
 * The most-used screen, so density and scanability win over decoration. Every
 * numeric column is monospaced and right-aligned so magnitudes line up and a
 * trader can compare down a column without reading.
 */
import Link from 'next/link';
import { getFeed } from '@/lib/api';
import { Hallmark, markColor } from '@/components/Hallmark';

export const dynamic = 'force-dynamic';

const GRID = '76px minmax(0, 1.6fr) 132px 118px 108px 92px';

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function since(ts: number) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

export default async function FeedPage() {
  const rows = await getFeed(60);

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', minHeight: '100vh' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 20,
          padding: '34px 22px 24px',
          borderBottom: '1px solid var(--rule)',
        }}
      >
        <div>
          <h1 className="serif" style={{ fontSize: 38, fontWeight: 400 }}>
            Newly struck
          </h1>
          <div className="label" style={{ marginTop: 9 }}>
            Tokens deployed on Arc · assayed on discovery
          </div>
        </div>
        <div className="label" style={{ textAlign: 'right', lineHeight: 1.7 }}>
          Chain 5042 · Arc mainnet
          <br />
          <span style={{ color: 'var(--faint)' }}>Verified on-chain · context unscored</span>
        </div>
      </header>

      {rows.length === 0 ? (
        <EmptyFeed />
      ) : (
        <section>
          <div
            className="label"
            style={{
              display: 'grid',
              gridTemplateColumns: GRID,
              alignItems: 'center',
              padding: '11px 22px',
              borderBottom: '1px solid var(--rule)',
              background: 'var(--panel-alt)',
              fontSize: 10.5,
              letterSpacing: '0.18em',
            }}
          >
            <div>Mark</div>
            <div>Token</div>
            <div style={{ textAlign: 'right' }}>Token tax</div>
            <div style={{ textAlign: 'right' }}>Venue fee</div>
            <div style={{ textAlign: 'right' }}>Assayed</div>
            <div style={{ textAlign: 'right' }}>Verdict</div>
          </div>

          {rows.map((r) => {
            // A honeypot is struck .000; everything else shows its score.
            const color = markColor(r.score, r.isHoneypot);
            return (
              <Link
                key={r.token}
                href={`/token/${r.token}`}
                className="row-hover"
                style={{
                  display: 'grid',
                  gridTemplateColumns: GRID,
                  alignItems: 'center',
                  padding: '10px 22px',
                  borderBottom: '1px solid var(--rule-soft)',
                  cursor: 'pointer',
                }}
              >
                <Hallmark mark={r.mark} color={color} size="row" />

                <div style={{ display: 'flex', alignItems: 'baseline', gap: 11, minWidth: 0 }}>
                  <span
                    className="mono"
                    style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.06em' }}
                  >
                    {shortAddr(r.token)}
                  </span>
                  {r.flags.length > 0 && (
                    <span
                      style={{
                        color: 'var(--faint)',
                        fontSize: 12,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {r.flags[0]}
                    </span>
                  )}
                </div>

                <div
                  className="mono"
                  style={{
                    textAlign: 'right',
                    fontSize: 13,
                    color: r.tokenTaxBps > 300 ? 'var(--fail)' : 'var(--dim)',
                  }}
                >
                  {r.tokenTaxBps} bps
                </div>

                {/* Venue fee is never coloured as a fault — it is the
                    launchpad's business model, not the token's behaviour. */}
                <div
                  className="mono"
                  style={{ textAlign: 'right', fontSize: 13, color: 'var(--faint)' }}
                >
                  {r.venueFeeBps} bps
                </div>

                <div
                  className="mono"
                  style={{ textAlign: 'right', fontSize: 13, color: 'var(--faint)' }}
                >
                  {since(r.checkedAt)}
                </div>

                <div
                  className="mono"
                  style={{
                    textAlign: 'right',
                    fontSize: 10.5,
                    letterSpacing: '0.15em',
                    color: r.isHoneypot ? 'var(--fail)' : color,
                  }}
                >
                  {r.isHoneypot ? 'HONEYPOT' : r.score >= 750 ? 'CLEAN' : 'CAUTION'}
                </div>
              </Link>
            );
          })}

          <div className="label" style={{ padding: '14px 22px', color: 'var(--faint)' }}>
            {rows.length} assayed
          </div>
        </section>
      )}
    </main>
  );
}

/**
 * Arc is days old and the API may be down. An empty feed is a designed state —
 * it explains itself and shows an unstruck punch rather than a spinner.
 */
function EmptyFeed() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 20,
        padding: '130px 22px',
        textAlign: 'center',
      }}
    >
      <Hallmark state="blank" size="row" />
      <div className="serif" style={{ fontSize: 24 }}>
        Nothing to assay
      </div>
      <p style={{ maxWidth: 420, color: 'var(--faint)', fontSize: 13, lineHeight: 1.6 }}>
        No assayed tokens yet. Run the indexer to discover pools and assay them:
        <br />
        <span className="mono" style={{ color: 'var(--dim)' }}>
          pnpm --filter @fineness/indexer backfill
        </span>
      </p>
      <div className="label" style={{ color: 'var(--faint)' }}>
        Watching · Arc mainnet
      </div>
    </div>
  );
}
