# Fineness — Design Brief

Pre-trade risk verification for Arc, Circle's stablecoin L1. Tells a trader
whether a newly launched token is safe to buy, before they buy it.

---

## Concept

The name comes from metal assaying. **Fineness** is the measured purity of a
precious metal, expressed as parts per thousand — `.999` fine silver, `.750` for
18k gold. Assayers test metal, then strike a hallmark into it.

That is exactly what this product does to tokens.

Use this literally. The risk score **is** a fineness mark: `.999`, `.875`,
`.500`, `.000`. Render it as a struck hallmark — punched, stamped,
physical-feeling — not a progress bar or a percentage badge. This is the
signature element of the entire interface and must be instantly recognisable at
any size, from a 16px table row to a full report header.

---

## The central design problem

The product shows two kinds of information, and they must never be mistaken for
one another.

### Verified

Deterministic on-chain checks:

- Honeypot simulation (buy → sell round-trip)
- Token transfer tax in bps — what the *token* takes
- Hook fee in bps — what the *launchpad* takes. A separate number, always.
- Ownership renounced
- Proxy admin slot clear
- Hook permissions — decoded from the hook's address, flagged when they deviate
  from the ecosystem baseline
- Holder concentration

There is no LP-burn check. Arc runs Uniswap v4, which has no LP token to burn.
See the build plan for the reasoning; the report should state this rather than
leave a conspicuous absence.

Provable, machine-decidable, impossible for the token's creator to fake. **This
is what earns the hallmark.**

### Context

- Socials and description
- X account age and rename history
- Developer's previous launches

Useful, but trivially fabricated by the deployer. Shown so the trader has
everything on one screen instead of four browser tabs. **Deliberately unscored.**

### The requirement

Make the difference visible without a word of explanation.

Verified content should feel struck, permanent, assayed — weight, contrast, hard
edges. Context should feel provisional and lighter — noted, not certified.

A user glancing at the screen for one second must know which is which.

---

## Tone

Institutional restraint, not crypto neon. Arc launched with BlackRock, Visa and
Mastercard as founding validators. This is an instrument — closer to a laboratory
readout or a certificate of assay than a trading terminal. Precise, quiet,
confident.

**Avoid:** gradient purple, glow effects, rocket iconography, anything that reads
as a memecoin dashboard.

Dark-first — traders use this at 3am. Monospace for all on-chain values:
addresses, amounts, bps, and the fineness mark itself.

---

## Screens

### 1. Feed

Dense, scannable table of newly launched tokens. Each row carries: fineness mark,
name, market cap, liquidity, age, top-10 share. Sortable; filterable by minimum
market cap (default floor 5k).

This is the most-used screen. Prioritise density and scanability over decoration.

### 2. Assay report

One token in full. The hallmark large at the top, the verified checks broken
out with pass/fail and reasoning, then the context section clearly demarcated
below.

### 3. Buy panel

Amount in USDC, slippage control, buy button.

The button is **disabled when the token fails verification**, with the reason
stated plainly. Design the disabled state as deliberate and protective — not
broken, not an error.

### 4. Bridge

Bringing USDC onto Arc. Onboarding, used once. Keep it calm and out of the way.

Note: USDC is Arc's gas token, so a wallet arriving with zero USDC cannot
transact at all. The faucet or paymaster path needs a designed state, not an
error message.

---

## Edge cases — design these, don't treat them as afterthoughts

**Insufficient data.** Below roughly 15k market cap a token is minutes old and
holder concentration cannot be honestly judged. This needs its own visual state,
distinct from both pass and fail. *"Too early to assay."*

This is the hardest and most important visual in the product. Most tools collapse
"we checked and it's fine" into "we couldn't check" — and that gap is precisely
where a trader gets hurt. If this state is right, the rest follows.

**The normal hook.** 91% of Arc pools attach a hook that takes a cut of every
swap. This is ordinary launchpad behaviour, not a threat. But "this pool contains
code that runs on every trade" sounds alarming, and the report has to state it
without making 91% of the chain look dangerous. The design job is a resting state
that reads as *noted and normal*, so that the rare genuinely anomalous
permission set reads as loud by contrast. If everything is flagged, nothing is.

**Two taxes, not one.** The token's transfer tax and the launchpad's hook fee are
separate numbers and must never be summed into a single figure. A 1% hook fee is
the cost of doing business; a 20% token tax is a warning. Show them apart, and
make the token's tax the one carrying visual weight.

**Empty feed.** Arc is days old. The feed may genuinely contain nothing.

**Missing context.** The social data source can and will fail. The report must
still read as complete without it.

---

## Where to start

The fineness hallmark itself, then the assay report. Those two set everything
else.
