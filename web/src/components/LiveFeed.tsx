'use client';

/**
 * The live feed.
 *
 * Subscribes to the API's SSE stream so newly assayed tokens appear without a
 * reload. Two deliberate behaviours:
 *
 *  1. **New rows are marked, not animated.** A row that arrived since you
 *     started looking gets a quiet left rule and a NEW tag for a few seconds.
 *     Sliding or fading rows on a dense table makes it unreadable precisely
 *     when a launch burst makes it most worth reading.
 *
 *  2. **The connection state is visible.** A feed that silently stops updating
 *     is the failure mode that actually hurts — you assume you are seeing
 *     everything. The header always says whether it is live, retrying, or
 *     showing a static snapshot.
 *
 * Falls back to polling if EventSource is unavailable, and renders the
 * server-provided rows immediately so there is never an empty first paint.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Hallmark, markColor } from './Hallmark';

export interface FeedRow {
  token: string;
  name: string | null;
  symbol: string | null;
  logo: string | null;
  mark: string;
  grade: number;
  /** null = not enough history yet. Never render as 0%. */
  changePct: number | null;
  active: boolean;
  swaps: number;
  direction: 'up' | 'down' | 'flat' | null;
  /** First time we assayed it — what makes a resurfaced row "not new". */
  firstSeen: number;
  score: number;
  isHoneypot: boolean;
  tokenTaxBps: number;
  venueFeeBps: number;
  marketCap: number | null;
  flags: string[];
  checkedAt: number;
  pricedAt: number;
}

type Conn = 'live' | 'retrying' | 'static';

const GRID = '76px 30px minmax(0, 1.35fr) 130px 86px 64px 88px 84px 84px';

/** Market-cap floors. "Any" is first and is the default — see the note below. */
const FLOORS = [
  { label: 'ANY', value: 0 },
  { label: '$5K', value: 5_000 },
  { label: '$25K', value: 25_000 },
  { label: '$100K', value: 100_000 },
];

export function LiveFeed({
  initial,
  apiBase,
}: {
  initial: FeedRow[];
  apiBase: string;
}) {
  const [rows, setRows] = useState<FeedRow[]>(initial);
  const [conn, setConn] = useState<Conn>('static');
  const [floor, setFloor] = useState(0);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const known = useRef(new Set(initial.map((r) => r.token)));

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;

    const es = new EventSource(`${apiBase}/stream?minMcap=${floor}`);

    es.onopen = () => setConn('live');
    es.onerror = () => setConn('retrying'); // EventSource retries on its own

    es.onmessage = (ev) => {
      try {
        const body = JSON.parse(ev.data) as { tokens: FeedRow[] };
        const incoming = body.tokens ?? [];

        // Mark anything we have not seen before in this session.
        const added = incoming.filter((r) => !known.current.has(r.token));
        if (added.length > 0) {
          for (const r of added) known.current.add(r.token);
          setFresh((prev) => {
            const next = new Set(prev);
            for (const r of added) next.add(r.token);
            return next;
          });
          // Let the marker fade out of relevance without animating the row.
          window.setTimeout(() => {
            setFresh((prev) => {
              const next = new Set(prev);
              for (const r of added) next.delete(r.token);
              return next;
            });
          }, 12_000);
        }
        setRows(incoming);
        setConn('live');
      } catch {
        // A malformed frame should not kill the stream.
      }
    };

    return () => es.close();
  }, [apiBase, floor]);

  const filtered =
    floor === 0
      ? rows
      : // Unknown market cap is kept, not hidden. Hiding it would quietly
        // shrink the feed and imply those tokens failed the filter.
        rows.filter((r) => r.marketCap === null || r.marketCap >= floor);

  // Surging tokens are lifted to the top, whatever their age.
  //
  // Without this the feed is purely chronological, so a token you scrolled past
  // is gone for good — including the one that has since tripled. Resurfacing it
  // is the difference between a decision deferred and a decision lost.
  const visible = [...filtered].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return 0;
  });
  const activeCount = filtered.filter((r) => r.active).length;

  return (
    <>
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

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {activeCount > 0 && (
              <span className="mono" style={{ fontSize: 9.5, letterSpacing: '0.16em', color: 'var(--pass)' }}>
                ↻ {activeCount} ACTIVE AGAIN
              </span>
            )}
            <ConnBadge conn={conn} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="label" style={{ marginRight: 4 }}>
              Min market cap
            </span>
            {FLOORS.map((f) => (
              <button
                key={f.label}
                onClick={() => setFloor(f.value)}
                className="mono chip"
                style={{
                  padding: '6px 11px',
                  fontSize: 11,
                  cursor: 'pointer',
                  background: floor === f.value ? '#1b1f22' : 'transparent',
                  border: `1px solid ${floor === f.value ? '#3a4145' : 'var(--rule)'}`,
                  color: floor === f.value ? 'var(--ink)' : 'var(--muted)',
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {visible.length === 0 ? (
        <EmptyFeed floor={floor} />
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
            <div />
            <div>Token</div>
            <div style={{ textAlign: 'right' }}>Market cap</div>
            <div style={{ textAlign: 'right' }}>15m</div>
            <div style={{ textAlign: 'right' }}>Swaps</div>
            <div style={{ textAlign: 'right' }}>Exit cost</div>
            <div style={{ textAlign: 'right' }}>Priced</div>
            <div style={{ textAlign: 'right' }}>Verdict</div>
          </div>

          {visible.map((r) => {
            const isNew = fresh.has(r.token);
            const color = markColor(r.grade, r.isHoneypot);
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
                  // The only marker for a new row: a rule, not a motion.
                  // Two different reasons a row deserves attention, two
                  // different rules. Surging wins, because it is the one you
                  // may already have dismissed once.
                  boxShadow: r.active
                    ? `inset 2px 0 0 ${r.direction === 'down' ? 'var(--early)' : 'var(--pass)'}`
                    : isNew
                      ? 'inset 2px 0 0 var(--early)'
                      : undefined,
                }}
              >
                <Hallmark mark={r.mark} color={color} size="row" />

                <TokenLogo src={r.logo} symbol={r.symbol} />

                <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, minWidth: 0 }}>
                  <span
                    className="mono"
                    style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.04em' }}
                  >
                    {r.symbol ?? `${r.token.slice(0, 6)}…${r.token.slice(-4)}`}
                  </span>
                  {r.name && r.name !== r.symbol && (
                    <span
                      style={{
                        color: 'var(--faint)',
                        fontSize: 12,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        minWidth: 0,
                      }}
                    >
                      {r.name}
                    </span>
                  )}
                  {r.active ? (
                    // Explicitly "again", not "new". The whole point of
                    // resurfacing is that you have probably seen this token
                    // before and passed on it — saying NEW here would be a lie
                    // and would make you evaluate it as a fresh launch.
                    <span
                      className="mono"
                      style={{
                        fontSize: 9,
                        letterSpacing: '0.18em',
                        color: r.direction === 'down' ? 'var(--early)' : 'var(--pass)',
                        flex: 'none',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      ↻ AGAIN · {seenPhrase(r.firstSeen)}
                      {r.direction === 'up' ? ' ▲' : r.direction === 'down' ? ' ▼' : ''}
                    </span>
                  ) : isNew ? (
                    <span
                      className="mono"
                      style={{
                        fontSize: 9,
                        letterSpacing: '0.18em',
                        color: 'var(--early)',
                        flex: 'none',
                      }}
                    >
                      NEW
                    </span>
                  ) : null}
                </div>

                <div
                  className="mono"
                  style={{ textAlign: 'right', fontSize: 13, color: 'var(--dim)' }}
                >
                  {/* Unknown is shown as unknown, never as $0. */}
                  {r.marketCap === null ? '—' : money(r.marketCap)}
                </div>

                {/* Movement since we last looked. This is what brings a token
                    back into view after you scrolled past it. */}
                <div
                  className="mono"
                  style={{
                    textAlign: 'right',
                    fontSize: 13,
                    color:
                      r.changePct === null
                        ? 'var(--faint)'
                        : r.changePct >= 25
                          ? 'var(--pass)'
                          : r.changePct > 0
                            ? 'var(--dim)'
                            : r.changePct < 0
                              ? 'var(--fail)'
                              : 'var(--faint)',
                  }}
                >
                  {r.changePct === null
                    ? '—'
                    : `${r.changePct > 0 ? '+' : ''}${r.changePct.toFixed(1)}%`}
                </div>

                {/* Swaps in the window. A flat market cap with zero swaps is
                    not a stale reading — it is an untraded token, and showing
                    the count is what makes that legible rather than broken. */}
                <div
                  className="mono"
                  style={{
                    textAlign: 'right',
                    fontSize: 13,
                    color: r.swaps > 0 ? 'var(--dim)' : 'var(--faint)',
                  }}
                >
                  {r.swaps > 0 ? r.swaps : '·'}
                </div>

                {/* Round-trip cost: what it takes to get in and back out.
                    Coloured, because it now drives the mark. */}
                <div
                  className="mono"
                  style={{
                    textAlign: 'right',
                    fontSize: 13,
                    color:
                      r.venueFeeBps + r.tokenTaxBps >= 2000
                        ? 'var(--fail)'
                        : r.venueFeeBps + r.tokenTaxBps >= 600
                          ? 'var(--early)'
                          : 'var(--dim)',
                  }}
                >
                  {((r.venueFeeBps + r.tokenTaxBps) / 100).toFixed(1)}%
                </div>

                <div
                  className="mono"
                  style={{ textAlign: 'right', fontSize: 13, color: 'var(--faint)' }}
                >
                  {since(r.pricedAt ?? r.checkedAt)}
                </div>

                <div
                  className="mono"
                  style={{
                    textAlign: 'right',
                    fontSize: 10.5,
                    letterSpacing: '0.15em',
                    color: r.isHoneypot || r.grade === 0 ? 'var(--fail)' : color,
                  }}
                >
                  {verdictFor(r)}
                </div>
              </Link>
            );
          })}

          <div className="label" style={{ padding: '14px 22px', color: 'var(--faint)' }}>
            {visible.length} assayed
            {activeCount > 0 &&
              ` · ${activeCount} returning on 15m price action — previously seen, not new`}
            {floor > 0 && ' · unpriced tokens included'}
          </div>
        </section>
      )}
    </>
  );
}

/**
 * One word per grade. Each is a claim the checks can back, not a vibe:
 * the mark and the word must never disagree.
 */
function verdictFor(r: FeedRow): string {
  if (r.isHoneypot) return 'HONEYPOT';
  switch (r.grade) {
    case 3:
      return 'CLEAN';
    case 2:
      return 'FAIR';
    case 1:
      return 'CAUTION';
    default:
      return 'FAIL';
  }
}

function ConnBadge({ conn }: { conn: Conn }) {
  const map = {
    live: { text: 'LIVE', color: 'var(--pass)' },
    retrying: { text: 'RECONNECTING', color: 'var(--early)' },
    static: { text: 'SNAPSHOT', color: 'var(--faint)' },
  } as const;
  const s = map[conn];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: s.color,
          display: 'inline-block',
        }}
      />
      <span className="mono" style={{ fontSize: 9.5, letterSpacing: '0.18em', color: s.color }}>
        {s.text}
      </span>
    </div>
  );
}

function EmptyFeed({ floor }: { floor: number }) {
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
      <p style={{ maxWidth: 440, color: 'var(--faint)', fontSize: 13, lineHeight: 1.6 }}>
        {floor > 0
          ? 'No assayed token is above this market cap floor. Most tokens launching on Arc right now sit in the low thousands.'
          : 'No tokens assayed yet. Start the watcher to discover and assay pools as they are created:'}
        {floor === 0 && (
          <>
            <br />
            <span className="mono" style={{ color: 'var(--dim)' }}>
              pnpm --filter @fineness/indexer watch
            </span>
          </>
        )}
      </p>
    </div>
  );
}

/**
 * Market cap to two decimals.
 *
 * Rounding to "$3K" hid the thing that matters: whether the number is moving.
 * Tokens here sit in the low thousands and shift by cents, so an abbreviated
 * figure looked frozen even while the price changed. Only abbreviate past a
 * million, where two decimals still carry the movement.
 */
function money(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Token logo.
 *
 * Deployer-supplied and therefore context, never evidence — so it is small,
 * square and quiet, and it never sits near the hallmark's visual weight. IPFS
 * gateways are slow and frequently fail, so a failed load falls back to the
 * symbol's initial rather than leaving a broken-image box.
 */
function TokenLogo({ src, symbol }: { src: string | null; symbol: string | null }) {
  const [failed, setFailed] = useState(false);
  const initial = (symbol ?? '?').slice(0, 1).toUpperCase();

  const box: React.CSSProperties = {
    width: 22,
    height: 22,
    flex: 'none',
    border: '1px solid var(--rule)',
    background: 'var(--well)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  };

  if (!src || failed) {
    return (
      <div style={box}>
        <span className="mono" style={{ fontSize: 10, color: 'var(--faint)' }}>
          {initial}
        </span>
      </div>
    );
  }

  return (
    <div style={box}>
      {/* Plain img, not next/image: these are arbitrary third-party IPFS hosts
          that cannot be enumerated in next.config. */}
      <img
        src={src}
        alt=""
        width={22}
        height={22}
        loading="lazy"
        onError={() => setFailed(true)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
    </div>
  );
}

/**
 * How long this token has been in the feed.
 *
 * Reads as a reminder that you have met it before, which is the entire point of
 * resurfacing — so it never says "seen just now ago", and a token first seen
 * moments ago is simply active rather than returning.
 */
function seenPhrase(firstSeen: number): string {
  const m = Math.round((Date.now() - firstSeen) / 60_000);
  if (m < 2) return 'JUST LISTED';
  return `SEEN ${since(firstSeen)} AGO`;
}

function since(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}
