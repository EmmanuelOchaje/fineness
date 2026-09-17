# Architecture

Fineness is a pre-trade risk verification oracle for Arc. It answers one
question — *is this token safe to enter?* — and is deliberate about what it will
and will not claim to know.

Read this before writing code. `ARC-FINDINGS.md` has the first-hand mainnet
evidence behind every decision here.

---

## The split that defines the product

**Verified** — deterministic, machine-decidable, impossible for a deployer to
fake. This earns the fineness mark.

**Context** — socials, X account age, dev history. Shown so the trader has one
screen instead of four tabs. **Never scored**, because narrative is the cheapest
thing in crypto to fabricate.

Scoring context would make the verdict less trustworthy by association. This is a
design choice, not a missing feature, and it is stated in the UI and the README.

---

## What runs where

The single most important decision in the build. Getting it wrong costs a week.

### On-chain — `contracts/src/Fineness.sol`

Anything derivable from contract state or from *executing* a trade.

| Check | Method |
|---|---|
| Honeypot | USDC → token → USDC round trip, via v4 `unlock` callback |
| Token tax (bps) | pool-reported delta vs. actual `balanceOf` change |
| Hook fee (bps) | round-trip loss not explained by token tax or pool fee |
| Ownership renounced | `owner() == address(0)`, try/catch |
| Proxy admin clear | EIP-1967 admin slot must be zero |
| Hook permissions | low 14 bits of `key.hooks`, compared to baseline |
| Dynamic fee | `key.fee == 0x800000` |

### Off-chain — `indexer/`

Anything needing history or enumeration. **ERC-20 has no holder enumeration**, so
concentration cannot be computed on-chain at any price. This trips people up.

| Check | Method |
|---|---|
| Top-10 concentration | fold `Transfer` logs into a balance map |
| Pool discovery | `Initialize` events on the v4 PoolManager singleton |
| Market cap | pool liquidity × supply |
| Age | pool-init **block number**, never timestamp |

### Displayed but unscored — `api/` context service

Fetched lazily on the detail endpoint only, cached hard, and **fails soft**: a
hanging social fetch must never block a verdict already computed.

---

## Why simulation works at all

`eth_call` executes a state-changing function against simulated state and throws
the result away. So the Simulator genuinely buys and sells — nothing persists, no
gas is spent, no real trade happens.

Funding it is a single `balance` state override. On Arc the native balance and
the USDC ERC-20 balance are the same thing, so overriding native balance makes
`balanceOf` return USDC. Verified working on mainnet.

**Consequence for integrators:** `check()` performs a real round-trip swap. Via
`eth_call` that is free; called on-chain by another contract it would spend real
USDC and move the price. Integration is off-chain only. Say so plainly.

---

## Uniswap v4 is the whole ballgame

Arc has **no v2 or v3 deployment**. v4 is a singleton with an unlock/callback
pattern — there is no `swapExactTokensForTokens`.

```
poolManager.unlock(data)
  └─ unlockCallback(data)
       ├─ swap  USDC → token   settle / take
       └─ swap  token → USDC   settle / take
```

Three things that differ from every other chain, each of which produces a wrong
answer silently rather than an error:

1. **USDC is `0x3600…` in `PoolKey`**, not `address(0)`, despite being the native
   asset. The v4 native convention does not apply here.
2. **USDC is `currency0` in only 75% of pools** — `currency1` in 19%, absent
   entirely in 5%. Derive `zeroForOne` per pool from the actual key.
3. **95% of pools carry a hook**, with a fresh hook address per pool. Presence
   proves nothing.

---

## The differentiating check: hook permissions

v4 encodes a hook's permissions in the low 14 bits of its own address. On Arc,
4,156 surveyed pools cluster on one value:

```
0x2044 = BEFORE_INITIALIZE | AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA
```

A hook taking a cut of each swap — the standard launchpad pattern. **Normal.**

What the baseline lacks is `BEFORE_SWAP` and `BEFORE_SWAP_RETURNS_DELTA`: the
permissions that let a hook block a sell outright or re-price it arbitrarily. A
hook holding those when the ecosystem norm does not is a deterministic,
on-chain, v4-specific honeypot signal — and no other Arc tooling checks it.

Implemented as a pure function in `shared/src/hooks.ts`, unit-tested against real
observed addresses. No RPC, no deployment, no allowlist.

⚠️ The baseline is **measured, not canonical** — four days into a chain's life.
A second launchpad with different permissions would need it re-measured. It lives
in config and the README describes it as empirical.

---

## Two taxes, never one

Because `AFTER_SWAP_RETURNS_DELTA` is universal, part of every round trip's loss
is the *hook's* fee, not the *token's* transfer tax. The round trip measures total
loss correctly; attribution comes from comparing the delta PoolManager credits
against the Simulator's actual balance change.

Keep them separate all the way to the UI. *"This token taxes you 20%"* and
*"this launchpad charges 1%"* are different sentences, and collapsing them
misleads the user.

---

## Deliberate omissions

**LP burn.** v4 has no LP ERC-20 — liquidity is an ERC-721 position in
PositionManager, and Arc forbids zero-address transfers so only `0x…dead` is a
usable sink. Redefining it as position-NFT lock state is the most expensive check
to get right for the least signal. Hook permission decoding replaces it.

**Blacklist behaviour** (sell from a second fresh address). Cut for time, and the
most valuable thing on the cut list — a blacklisting token passes a single-address
round trip cleanly. First thing to restore if budget appears after deployment.

Both are stated in the README. A reasoned omission reads better than a
half-working check.

---

## Repo layout

```
fineness/
├── shared/      chain constants + hook permission decoder (pure, tested)
├── contracts/   Foundry. The submission — keep clean and well-tested.
├── indexer/     viem + SQLite. Pool discovery, holder folding.
├── api/         Fastify, read-only. Never signs anything.
└── web/         Next.js demo. Not started until check() works.
```

`shared/` exists because the chain constants and the hook decoder are needed by
contracts tests, indexer, api and web alike, and a second copy of the `0x2044`
baseline that drifts would be a silent correctness bug.

---

## Gotchas that cost hours

- **20 Gwei minimum base fee, silently enforced.** Underpriced transactions are
  dropped with no error and no receipt. Presents as a hang.
- **No tracing.** `debug_traceCall` and `trace_call` both return `-32014`.
  Contract-emitted events are the only debugging surface — instrument heavily.
- **`eth_getLogs` caps at 2000 results.** The suggested range in the error is
  computed against that node's head; clamp it against a fresh head before
  retrying or you get `-32014`, which looks like missing history and is not.
- **No WebSocket on Circle's RPC.** The indexer needs a third-party provider.
- **Block timestamps are non-decreasing, not strictly increasing.** Order by
  block number.
- **Canonical Uniswap v2/v3 addresses hold unrelated code on Arc.** A
  `getCode() != "0x"` liveness check passes, then every call returns empty.
  Always assert a known method returns a sane value.
