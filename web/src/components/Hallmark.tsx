/**
 * The fineness mark — a hallmark punched into metal.
 *
 * This is the signature element of the whole interface, and it has to survive
 * from a 66px table cell up to a 238px report header without turning into a
 * badge. The physicality comes from four stacked effects, none of which are
 * decoration:
 *
 *   - an octagonal clip-path, so the edge reads as a struck punch rather than a
 *     rounded-rect UI chip
 *   - a gradient bezel (the outer div's padding) catching light from upper-left
 *   - a radial inner face, darkest away from that light
 *   - inset shadows, which make the face sit BELOW the bezel rather than on it
 *
 * The text shadow is the important detail: a dark shadow above and a faint
 * light one below reads as debossed. Reverse them and it pops out as a sticker.
 *
 * Three states, and the third matters most:
 *
 *   struck    — assayed, shows the mark
 *   unstruck  — too early to assay. An EMPTY punch with a blank bar. Not a
 *               failure, not a pass: visibly a mark that was never made.
 *   blank     — nothing to show at all (empty feed)
 */
import type { CSSProperties } from 'react';

export type HallmarkState = 'struck' | 'unstruck' | 'blank';

interface Props {
  mark?: string;
  state?: HallmarkState;
  color?: string;
  size?: 'row' | 'report';
}

const SIZES = {
  row: {
    w: 66,
    h: 30,
    pad: 1,
    outer: 'polygon(7px 0, 59px 0, 66px 7px, 66px 23px, 59px 30px, 7px 30px, 0 23px, 0 7px)',
    inner: 'polygon(7px 0, 58px 0, 64px 6px, 64px 22px, 58px 28px, 7px 28px, 0 22px, 0 6px)',
    font: 14,
    barW: 30,
  },
  report: {
    w: 238,
    h: 136,
    pad: 3,
    outer:
      'polygon(16px 0, 222px 0, 238px 16px, 238px 120px, 222px 136px, 16px 136px, 0 120px, 0 16px)',
    inner:
      'polygon(15px 0, 219px 0, 232px 14px, 232px 116px, 219px 130px, 15px 130px, 0 116px, 0 14px)',
    font: 62,
    barW: 104,
  },
} as const;

export function Hallmark({ mark, state = 'struck', color, size = 'row' }: Props) {
  const s = SIZES[size];
  const isReport = size === 'report';

  const bezel: CSSProperties = {
    width: s.w,
    height: s.h,
    flex: 'none',
    clipPath: s.outer,
    padding: s.pad,
    background:
      state === 'blank'
        ? '#1A1E20'
        : isReport
          ? 'linear-gradient(152deg, #3C4347 0%, #22272A 38%, #14181A 74%, #2B3135 100%)'
          : 'linear-gradient(152deg, #383F43, #1C2124 55%, #262C30)',
    filter: isReport ? 'drop-shadow(0 10px 18px rgba(0,0,0,0.65))' : undefined,
  };

  const face: CSSProperties = {
    width: '100%',
    height: '100%',
    clipPath: s.inner,
    background:
      state === 'blank'
        ? '#0A0C0D'
        : isReport
          ? 'radial-gradient(120% 140% at 30% 18%, #14181A 0%, #0B0D0E 58%, #07080A 100%)'
          : 'radial-gradient(130% 150% at 30% 16%, #131719, #0A0C0D 70%)',
    boxShadow:
      state === 'blank'
        ? undefined
        : isReport
          ? 'inset 0 4px 9px rgba(0,0,0,0.95), inset 0 -2px 0 rgba(255,255,255,0.075), inset 2px 0 4px rgba(0,0,0,0.6)'
          : 'inset 0 2px 4px rgba(0,0,0,0.95), inset 0 -1px 0 rgba(255,255,255,0.07)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  return (
    <div style={bezel}>
      <div style={face}>
        {state === 'struck' && (
          <span
            className="mono"
            style={{
              fontSize: s.font,
              fontWeight: 700,
              letterSpacing: '-0.01em',
              color: color ?? 'var(--ink)',
              // Debossed, not embossed. Dark above, light below.
              textShadow:
                ' 0 -1px 0 rgba(0,0,0,0.95), 0 1px 0 rgba(255,255,255,0.1)',
            }}
          >
            {mark}
          </span>
        )}

        {state === 'unstruck' && (
          // An empty punch. The absence is the message: no mark was struck
          // because none could honestly be made yet.
          <div
            style={{
              width: s.barW,
              height: 3,
              borderTop: '1px solid rgba(0,0,0,0.9)',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              background: '#0A0C0D',
            }}
          />
        )}

        {state === 'blank' && (
          <span className="mono" style={{ fontSize: 13, color: '#33393C', letterSpacing: '0.1em' }}>
            · · ·
          </span>
        )}
      </div>
    </div>
  );
}

/** Score (0-1000) to an assay mark. `null` means not assayable. */
export function markFor(score: number | null): string | null {
  if (score === null) return null;
  return `.${String(Math.max(0, Math.min(999, score))).padStart(3, '0')}`;
}

export function markColor(score: number | null, isHoneypot: boolean): string {
  if (isHoneypot || score === 0) return 'var(--fail)';
  if (score === null) return 'var(--early)';
  if (score >= 750) return 'var(--pass)';
  if (score >= 500) return 'var(--ink)';
  return 'var(--fail)';
}
