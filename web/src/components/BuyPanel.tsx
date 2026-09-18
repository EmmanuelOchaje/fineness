'use client';

/**
 * The buy panel.
 *
 * The disabled state is the point of this component, so it is designed rather
 * than defaulted: a blocked buy reads as deliberate and protective, with the
 * reason stated in plain language. It must never look broken, and it must never
 * look like a loading state.
 *
 * The override exists because refusing outright would be dishonest about what
 * this tool is. Fineness reports; it does not custody funds and it is not a
 * gatekeeper. So the escape hatch is present, deliberately unstyled as a
 * primary action, and it makes the user state what they are overriding.
 */
import { useState } from 'react';

const SLIPPAGE = [0.5, 1, 3, 5];

interface Props {
  token: string;
  isHoneypot: boolean;
  score: number;
  early: boolean;
  blockingFlag: string | null;
}

export function BuyPanel({ token, isHoneypot, score, early, blockingFlag }: Props) {
  const [amount, setAmount] = useState('250.00');
  const [slippage, setSlippage] = useState(1);
  const [override, setOverride] = useState(false);

  const blocked = isHoneypot && !override;
  const canBuy = !blocked;

  return (
    <aside style={{ flex: '0 1 380px', minWidth: 300, padding: '34px 30px 80px' }}>
      <div className="label">Acquire</div>

      {isHoneypot && (
        <div
          style={{
            marginTop: 16,
            padding: '14px 16px',
            background: 'var(--fail-bg)',
            border: '1px solid var(--fail-edge)',
          }}
        >
          <div
            className="mono"
            style={{ fontSize: 10.5, letterSpacing: '0.16em', color: 'var(--fail-ink)' }}
          >
            BUY WITHHELD
          </div>
          <p style={{ marginTop: 9, fontSize: 12.5, lineHeight: 1.6, color: '#e8b4b0' }}>
            {blockingFlag}
          </p>
        </div>
      )}

      <div style={{ marginTop: 22 }}>
        <label className="label" htmlFor="amt">
          Amount · USDC
        </label>
        <input
          id="amt"
          className="mono"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          style={{
            width: '100%',
            marginTop: 9,
            padding: '12px 14px',
            background: 'var(--well)',
            border: '1px solid var(--rule)',
            color: 'var(--ink)',
            fontSize: 18,
            outline: 'none',
          }}
        />
      </div>

      <div style={{ marginTop: 20 }}>
        <div className="label">Max slippage</div>
        <div style={{ display: 'flex', gap: 7, marginTop: 9 }}>
          {SLIPPAGE.map((v) => (
            <button
              key={v}
              onClick={() => setSlippage(v)}
              className="mono chip"
              style={{
                flex: 1,
                padding: '8px 0',
                fontSize: 12,
                cursor: 'pointer',
                background: slippage === v ? '#1b1f22' : 'transparent',
                border: `1px solid ${slippage === v ? '#3a4145' : 'var(--rule)'}`,
                color: slippage === v ? 'var(--ink)' : 'var(--muted)',
              }}
            >
              {v}%
            </button>
          ))}
        </div>
      </div>

      <button
        disabled={!canBuy}
        style={{
          width: '100%',
          marginTop: 24,
          padding: '15px 0',
          fontFamily: 'var(--mono)',
          fontSize: 12,
          letterSpacing: '0.18em',
          cursor: canBuy ? 'pointer' : 'not-allowed',
          background: canBuy ? 'var(--ink)' : 'transparent',
          color: canBuy ? '#08090a' : 'var(--faint)',
          border: `1px solid ${canBuy ? 'var(--ink)' : 'var(--rule)'}`,
        }}
      >
        {blocked ? 'BUY DISABLED' : `BUY ${amount} USDC`}
      </button>

      {blocked && (
        <button
          onClick={() => setOverride(true)}
          className="label"
          style={{
            width: '100%',
            marginTop: 12,
            padding: '10px 0',
            background: 'transparent',
            border: 'none',
            color: 'var(--faint)',
            cursor: 'pointer',
            textDecoration: 'underline',
            textUnderlineOffset: 4,
          }}
        >
          Proceed against the assay
        </button>
      )}

      {override && isHoneypot && (
        <p style={{ marginTop: 12, fontSize: 12, lineHeight: 1.6, color: 'var(--fail-ink)' }}>
          Override active. The sell simulation failed — you may not be able to exit
          this position.
        </p>
      )}

      {early && !isHoneypot && (
        <p style={{ marginTop: 16, fontSize: 12, lineHeight: 1.6, color: 'var(--early)' }}>
          No mark was struck for this token. The deterministic checks passed, but
          distribution is too young to judge.
        </p>
      )}

      <p
        style={{
          marginTop: 26,
          fontSize: 11.5,
          lineHeight: 1.7,
          color: 'var(--faint)',
          borderTop: '1px solid var(--rule)',
          paddingTop: 16,
        }}
      >
        You sign from your own wallet. Fineness never holds your funds and never
        holds a key.
        <br />
        <br />
        Gas on Arc is paid in USDC — a wallet with zero USDC cannot transact at
        all, including to fund itself.
      </p>

      <div className="label" style={{ marginTop: 16, color: 'var(--faint)' }}>
        Score {score} / 1000 · {token.slice(0, 10)}…
      </div>
    </aside>
  );
}
