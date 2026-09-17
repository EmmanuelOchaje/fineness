# Fineness — Build Plan

**Submission target:** Arc Microgrants (DoraHacks), rolling until 14 Oct 2026, 23:59 ET.
**Hard requirements:** working build deployed on Arc **mainnet** + public repo.
**Positioning:** pre-trade risk verification for Arc. Not a degen terminal.

> **Revision 3** — rewritten against first-hand mainnet findings from 17 Sep 2026.
> Arc is Uniswap **v4 only**. This changes the Simulator substantially. See §4.
> The PoolKey question is **resolved** (§4). Pool survey of 4,156 live pools
> killed the naive hook check and replaced it with something better (§5).

---

## 1. Why this shape

Two terminals already shipped on Arc day one (ArcTools, Sidoor). Both display
descriptive metrics — market cap, liquidity, top-10 share. Neither returns a
**verdict**. The wedge is a permissionless contract that answers one question:
*is this token safe to enter?*

### The verdict / context split

This is the product's central discipline, and it should be visible in the UI.

- **Verdict** — the deterministic on-chain checks. Machine-decidable, pass/fail,
  cannot be faked by the deployer.
- **Context** — socials, description, X account age, dev wallet history.
  Displayed so the user has everything on one screen, **never scored**.

Narrative and community are the cheapest things in crypto to fabricate. Scoring
them would be dishonest and would make the verdict less trustworthy by
association. Showing them costs nothing and saves the user four browser tabs.

Say this explicitly in the README and on the detail view: *we verify this, we
show you that*.

**One honesty caveat on composability.** `check()` performs a real round-trip
swap. Through `eth_call` with a state override that is free and harmless; called
on-chain by another contract it would spend real USDC and move the price. So
third-party terminals can integrate, but off-chain only. State this in the README
rather than letting a reviewer discover it.

---

## 2. Verified network facts

Confirmed by direct RPC call against mainnet, 17 Sep 2026. Re-verify before
relying on any of it — the chain is one day old and moving.

| | |
|---|---|
| Chain ID | `5042` (`0x13b2`) |
| Primary RPC | `https://rpc.mainnet.arc.io` (public, no key) |
| Docs | `docs.arc.io` (moved from `docs.arc.network`) |
| Explorer | `explorer.arc.io` — **permissioned**, not publicly browsable |
| Gas token | USDC |
| USDC | `0x3600000000000000000000000000000000000000` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| CREATE2 Factory | `0x4e59b44847b379578588920cA78FbF26c0B4956C` |

### Uniswap v4 — the only DEX

| Contract | Address |
|---|---|
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| UniversalRouter | `0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1` |
| PositionManager | `0x6049c9a0e26405C0985f9E3685C87d0aE917f82B` |
| Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |

### Traps confirmed on-chain

**Squatted canonical Uniswap addresses.** `0x1F98431c…` (v3 Factory),
`0xE592427A…` (SwapRouter) and `0x68b34658…` (SwapRouter02) all **hold code** on
Arc, but it is unrelated Solidity 0.4-era bytecode. `factory()`, `owner()` and
`feeAmountTickSpacing()` all return empty `0x`. A naive `getCode() != "0x"`
liveness check passes, then every call silently returns nothing. Never probe for
a contract by bytecode presence alone — always assert a known method returns a
sane value.

**20 Gwei minimum base fee, silently enforced.** Transactions below it are
dropped by the mempool with no error and no receipt. In a demo this looks like a
hang, not a failure. Assert a floor explicitly in the deploy script and the
frontend.

**No WebSocket on Circle's endpoint.** Only Alchemy, Blockdaemon and QuickNode
expose `wss://`. The indexer needs a third-party provider and an API key.

**No tracing.** `debug_traceCall` and `trace_call` both return `-32014`. There is
no fallback if simulation misbehaves — instrument the Simulator itself.

**Zero-address transfers forbidden** at protocol level. Only `0x…dead` works as a
burn sink.

**Block timestamps are non-decreasing, not strictly increasing.** Sub-second
blocks may share a timestamp. Derive ordering from block numbers, never
timestamps.

**The `eth_getLogs` range hint can point past head.** The suggested narrower
range in the `-32602` error is computed against *that node's* head at *that
moment*. Reusing a hint captured from an earlier error can produce a `fromBlock`
ahead of current head, which returns `-32014 requested data not available` — this
reads like missing history but is not. Deep history is fine; logs 1M blocks back
retrieve normally. Always clamp a hint to a freshly read head before retrying.

### Pool landscape, surveyed 17 Sep 2026

4,156 `Initialize` events decoded from the live PoolManager. This is the
empirical basis for §4 and §5, and it is the part most likely to age.

| | |
|---|---|
| Pools sampled | 4,156 — **the chain is not empty** |
| Fee tier | `10000` (1%) on 96%; 19 pools use `0x800000`, the dynamic-fee flag |
| USDC as `currency0` | 75% |
| USDC as `currency1` | 19% |
| **No USDC at all** | **5% (220 pools)** |
| Pools with a non-zero hook | **95%** |
| Distinct hook addresses | **3,823** across 3,965 hooked pools — one hook per pool |

---

## 3. Repo layout

```
fineness/
├── contracts/          Foundry. The submission.
│   ├── src/
│   │   ├── Fineness.sol        the oracle
│   │   ├── Simulator.sol       v4 unlock/callback swap harness
│   │   └── interfaces/
│   ├── test/
│   └── script/Deploy.s.sol
├── indexer/            Node + TypeScript + viem
│   ├── src/watch.ts       pool-init subscription (needs wss provider)
│   ├── src/holders.ts     chunked Transfer-log holder index
│   └── src/db.ts          SQLite
├── api/                Thin REST/WS layer
└── web/                Next.js demo frontend
```

---

## 4. Simulation on Uniswap v4

### Funding: solved, and simpler than planned

State overrides are **supported** on mainnet `eth_call` — `balance`, `code` and
`stateDiff` all verified working.

Better still: native and ERC-20 USDC share one balance. Overriding an address's
*native* balance to `0xde0b6b3a7640000` made the USDC ERC-20 `balanceOf` return
`1000000` (1 USDC, 6 decimals).

**So a single `balance` override funds the Simulator.** No pre-funded contract,
no real USDC on mainnet, no key management. The fallback option from revision 1
is deleted.

### Swapping: harder than planned

v4 is a singleton with an unlock/callback pattern. There is no
`swapExactTokensForTokens`. The round-trip must be:

```
poolManager.unlock(data)
  └─ unlockCallback(data)
       ├─ poolManager.swap(key, params, hookData)   USDC → token
       ├─ settle / take
       ├─ poolManager.swap(key, params, hookData)   token → USDC
       └─ settle / take
```

Go direct to PoolManager rather than through UniversalRouter — fewer moving
parts and no Permit2 signature plumbing for a simulation that never persists.

### PoolKey currency representation: RESOLVED

**USDC appears in `PoolKey` as the ERC-20 address
`0x3600000000000000000000000000000000000000`, not as `address(0)`.** Confirmed
across 4,156 decoded `Initialize` events. Build against `0x3600…` directly.

### But USDC is not always `currency0`

v4 sorts currencies by address, and `0x3600…` sorts mid-range. So:

- USDC is `currency0` in 75% of pools
- USDC is `currency1` in 19%
- USDC is **absent entirely** in 5% (220 pools — token/token pairs)

**The Simulator must derive `zeroForOne` per pool from the actual key.** Assuming
USDC is `currency0` swaps the wrong direction on a fifth of the chain, and the
failure is quiet — you get a plausible-looking number that is backwards.

`check()` also needs a defined answer for pools containing no USDC. Simplest
honest behaviour: reject them with a distinct status rather than inventing a
route through an intermediate pool. Multi-hop routing is out of scope.

### Hooks: near-universal, so presence proves nothing

95% of Arc pools carry a hook, and there are 3,823 distinct hook addresses across
3,965 hooked pools — **a fresh hook deployed per pool**. So a non-zero `hooks`
field flags almost the entire chain, and address allowlisting is impossible
because addresses are never reused.

The signal is in the *permissions*, not the presence. See §5.

---

## 5. What runs where

### On-chain (`Fineness.sol`)

| Check | Method |
|---|---|
| Honeypot | USDC → token → USDC round-trip via v4 `unlock` callback |
| Token tax (bps) | pool-reported delta vs. actual `balanceOf` change, per leg |
| Hook fee (bps) | round-trip loss not attributable to token tax or pool fee |
| Ownership renounced | `owner()` == `address(0)`, try/catch wrapped |
| Proxy admin clear | EIP-1967 admin slot must be zero |
| **Hook permissions** | decode low 14 bits of `key.hooks`; flag deviations |
| Dynamic fee | `key.fee == 0x800000` — fee can change between quote and trade |

### Hook permission decoding — the differentiating check

Presence of a hook proves nothing on Arc (95% of pools, §4). The permissions do.

v4 encodes a hook's permissions in the **low 14 bits of its own address**. Across
the four dominant hook-address suffixes on Arc, every one decodes to the same
permission set:

```
low14 = 0x2044  →  BEFORE_INITIALIZE | AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA
```

That is the standard launchpad pattern — a hook taking a cut of each swap, which
matches aka.fun's documented trading fee. **It is the norm, not a red flag.**

What the norm conspicuously lacks is `BEFORE_SWAP` and
`BEFORE_SWAP_RETURNS_DELTA` — the permissions that let a hook **block a sell
outright or arbitrarily re-price it**. A pool whose hook holds those bits when
the ecosystem baseline does not is a deterministic, on-chain, v4-specific
honeypot signal.

So: extract the low 14 bits, compare against the `0x2044` baseline, flag
deviations, and weight the before-swap family heavily. No allowlist, no external
data, no extra RPC call. As far as we can tell no existing Arc tooling does this,
and it is the strongest differentiator in the product.

Verify the bit-position table against v4-core `Hooks.sol` before implementing —
the ordering above is derived from observed addresses and should be confirmed
against source, not trusted.

### Two taxes, not one

Because `AFTER_SWAP_RETURNS_DELTA` is universal, part of every round-trip loss is
the **hook's** fee, not the **token's** transfer tax. The round trip measures
total loss correctly, but conflating them tells the user the wrong story:
*"this token taxes you 20%"* and *"this launchpad charges 1%"* are very different
sentences. Attribute them by comparing the delta PoolManager credits against the
Simulator's actual balance change — the gap is the token's transfer tax by
construction. Report them as separate fields.

This also supplies the missing baseline for buy tax: it needs no Quoter call and
no notion of "expected" price.

### Dropped checks, stated plainly

**LP burn.** v4 has no LP ERC-20; liquidity is an ERC-721 position in
PositionManager, and Arc forbids zero-address transfers so only `0x…dead` is a
usable sink. Redefining it as position-NFT lock state is the most expensive check
to get right for the least signal. Hook permission decoding replaces it.

**Blacklist behaviour** (simulate a sell from a second fresh address). Cut for
time, and it is the most valuable thing on the cut list — a blacklisting token
passes a single-address round trip cleanly. If any budget appears after step 5,
spend it here first.

Say both plainly in the README. A stated, reasoned omission reads better than a
half-working check.

### Off-chain (`indexer/`)

**ERC-20 has no holder enumeration** — concentration cannot be computed on-chain.

| Check | Method |
|---|---|
| Top-10 concentration | fold `Transfer` logs into a balance map (see §6) |
| Pool discovery | `Initialize` events on PoolManager |
| Market cap | pool liquidity × supply |
| Age | pool-init **block number** (not timestamp) |

### Context layer (displayed, not scored)

Fetched lazily on the detail view only — never per-row in the feed.

| Item | Source |
|---|---|
| Name, symbol, description | token metadata |
| Socials | flag if links don't resolve |
| X account age and renames | X API — recycled handles are a known pattern |
| Dev wallet prior launches | indexer |

### Cut entirely

Volume and order-flow analysis, sniping, multi-chain, any *scoring* of narrative
or community.

---

## 6. `eth_getLogs` is capped at 2000 results

Exceeding it returns `-32602` **with a suggested narrower block range in the
error message** — parse and follow it. At current activity 2000 results spans
roughly 40 blocks.

So `holders.ts` cannot fold `Transfer` logs from pool creation to head in one
query. It needs chunked pagination with adaptive range sizing and backoff from
block one. A single wide range query will fail every time.

---

## 7. Targeting low market caps (~5k)

**Unaffected.** All on-chain checks are valid from block one.

**Degraded.** Top-10 concentration on a four-minute-old token is close to
meaningless — early buyers naturally hold large shares before distribution.
A flat 20% rule would flag almost every normal launch.

**Fix.** Scale the threshold with market cap and age. Below roughly 15k, surface
the raw number with verdict `INSUFFICIENT_DATA` and no pass/fail. Above that,
tighten toward 20%.

---

## 8. Build order

Strictly sequential. Do not start the frontend until `check()` works.

0. ~~Resolve the PoolKey currency question~~ ✅ **done — USDC is `0x3600…`**
1. Scaffold + confirm a wss provider
2. `Simulator.sol` — v4 unlock/callback round-trip
3. `Fineness.sol` — authority, proxy, hook checks + aggregate verdict
4. Fork tests against real Arc state
5. Deploy to Arc mainnet
6. Indexer — pool discovery + chunked holder index
7. API
8. Frontend — bridge, feed, detail, buy
9. Context layer (last; it's the droppable one)
10. README, diagram, demo video

Ship at step 5 if time runs short. A deployed, tested contract with a README is
a valid submission. A half-built frontend is not.

---

## 9. Claude Code prompts

Keep this file in the repo root and tell Claude to read it at the start of each
session.

### Prompt 0 — ✅ resolved 17 Sep 2026, results in §2 and §4

Answered: USDC is `0x3600…` in `PoolKey`; 4,156 pools exist; 95% carry a hook;
hook permissions cluster on `0x2044`. Nothing to re-run unless the chain has
moved on materially — in which case re-survey §2's pool-landscape table, since it
is the fastest-ageing part of this document.

`Initialize` topic0, for re-running the survey:
`0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438`
(`currency0` and `currency1` are indexed topics 2 and 3; `fee`, `tickSpacing`,
`hooks`, `sqrtPriceX96`, `tick` are ABI-packed in `data`, in that order.)

### Prompt 1 — scaffold

> Set up a pnpm monorepo named `fineness` with workspaces: `contracts`
> (Foundry), `indexer` (Node + TypeScript + viem), `api`, `web` (Next.js).
>
> Arc mainnet: chain ID 5042, RPC `https://rpc.mainnet.arc.io`, gas token is
> USDC at `0x3600000000000000000000000000000000000000`. Define the chain for
> viem manually — it won't be in `viem/chains`.
>
> Configure `foundry.toml` with the Arc RPC and a fork profile. Add
> `.env.example`. Do not commit private keys.
>
> Critical: minimum base fee on Arc is 20 Gwei and transactions below it are
> silently dropped with no error or receipt. Set an explicit floor in the
> Foundry config and in a shared constants module.
>
> Circle's public RPC has no WebSocket. The indexer needs Alchemy, Blockdaemon
> or QuickNode. Add the endpoint to `.env.example` as a required variable.

### Prompt 2 — simulator (v4)

> Write `contracts/src/Simulator.sol` for a Uniswap v4 round-trip swap on Arc.
>
> PoolManager: `0x8366a39CC670B4001A1121B8F6A443A643e40951`. **USDC appears in
> `PoolKey` as the ERC-20 address `0x3600000000000000000000000000000000000000`,
> not as `address(0)`** — this is confirmed against 4,156 live pools, do not use
> the v4 native-currency convention here.
>
> Single entry point `simulate(PoolKey calldata key, uint256 usdcAmount)` that
> calls `poolManager.unlock(...)` and, inside `unlockCallback`, performs: swap
> USDC → token, settle/take, record tokens received; then swap the full token
> balance back → USDC, settle/take, record USDC returned.
>
> **Derive `zeroForOne` from the key at runtime. Do not assume USDC is
> `currency0`** — it is `currency0` in only 75% of Arc pools and `currency1` in
> 19%. Getting this wrong swaps the wrong direction and returns a plausible
> number that is backwards, with no error.
>
> If the key contains no USDC on either side (5% of pools are token/token),
> revert with a distinct, named error. Do not attempt multi-hop routing.
>
> Record, per leg, **both** the balance delta PoolManager reports **and** the
> Simulator's actual `balanceOf` change. The gap between them is the token's
> transfer tax; the rest of the round-trip loss is pool fee plus hook fee. The
> oracle needs both numbers to tell those apart, so return both — do not
> pre-compute a single "tax" figure here.
>
> Return `tokensReceived`, `usdcReturned`, the four delta figures above,
> `sellSucceeded`, and a revert reason if the sell failed.
>
> This is called via `eth_call` with a **native balance override** funding the
> contract — on Arc, native and ERC-20 USDC share a balance, so overriding native
> balance makes `balanceOf` return USDC. It is NOT a view function and needs no
> real funds.
>
> Wrap the sell leg in try/catch so a blocked sell returns `sellSucceeded =
> false` rather than bubbling up. A honeypot must produce a clean negative
> result, not a failed call.
>
> **Emit events at every step.** `debug_traceCall` and `trace_call` are
> unavailable on Arc — returning `-32014` — so contract-emitted events are the
> only debugging surface. Do not skip this.
>
> Go direct to PoolManager, not through UniversalRouter. Avoid Permit2.

### Prompt 3 — oracle

> Write `contracts/src/Fineness.sol`.
>
> Public function `check(address token, PoolKey calldata key)` returning a
> `FinenessReport` struct:
>
> - `bool isHoneypot` — from Simulator, true if the sell leg fails
> - `uint16 buyTaxBps`, `uint16 sellTaxBps` — the **token's** transfer tax, from
>   the pool-delta vs. `balanceOf` gap the Simulator returns
> - `uint16 hookFeeBps` — the **hook's** cut, i.e. round-trip loss not explained
>   by token tax or the pool's own fee tier
> - `bool ownershipRenounced` — `owner()` returns `address(0)`, try/catch, since
>   not every token exposes `owner()`
> - `bool proxyAdminClear` — EIP-1967 admin slot
>   `0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103`;
>   non-zero means upgradeable and "renounced" is meaningless
> - `address hooks`, `uint16 hookPermissions`, `bool hookPermissionsAnomalous`
> - `bool dynamicFee` — `key.fee == 0x800000`; the fee can change between
>   simulation and the user's actual trade
> - `uint16 score` — 0-1000, rendered as a fineness mark (.999, .750, .000)
> - `string[] flags` — human-readable failures
>
> **Hook permissions are the check that matters here — read §5 before writing
> it.** Do not implement a `hooksClear` boolean: 95% of Arc pools have a hook and
> there are 3,823 distinct hook addresses across 3,965 hooked pools, so presence
> flags the whole chain and address allowlisting is impossible.
>
> Instead, extract the low 14 bits of `key.hooks` — v4 encodes a hook's
> permissions in its own address. The Arc baseline is `0x2044`
> (`BEFORE_INITIALIZE | AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA`), a standard
> launchpad fee hook. Flag deviations from that baseline, and weight `BEFORE_SWAP`
> and `BEFORE_SWAP_RETURNS_DELTA` heavily — those permissions let a hook block or
> arbitrarily re-price a sell, and the ecosystem norm does not carry them.
>
> Confirm the bit-position table against v4-core `Hooks.sol` rather than trusting
> the ordering quoted in §5, which was derived from observed addresses.
>
> Three rules that matter:
> - An upgradeable proxy with a non-zero admin fails even if `owner()` is zero.
>   Renouncing ownership on a proxy is a common deception.
> - Token tax and hook fee must stay separate fields all the way to the UI.
>   "This token taxes you 20%" and "this launchpad charges 1%" are different
>   statements and collapsing them misleads the user.
> - A hook matching the `0x2044` baseline is normal and must not cost score.
>
> No LP-burn check: v4 has no LP ERC-20. Do not attempt one.
> No holder concentration: computed off-chain.

### Prompt 4 — tests

> Write Foundry fork tests against live Arc mainnet state (chain 5042).
>
> Cover: a normal token passing cleanly; a high sell tax producing correct bps;
> a honeypot producing `isHoneypot = true` **without reverting the whole call**;
> an upgradeable proxy with zeroed `owner()` still failing `proxyAdminClear`; a
> token with no `owner()` function not reverting; a pool with a non-zero hook
> surfacing it correctly.
>
> Arc has ~4,156 live pools, so real fork targets exist for the normal-token and
> hooked-pool cases — use them. Write mocks in `test/mocks/` for the adversarial
> cases (honeypot, high tax, proxy-with-zeroed-owner) that may not exist on Arc
> yet, and note in comments that fork tests against real instances should replace
> them as the chain fills up.
>
> **A v4 hook only works at an address whose low 14 bits match its declared
> permissions.** You cannot `new MockHook()` and get a working hook — the deploy
> will revert. Use `deployCodeTo` at a crafted address carrying the right
> permission bits. Budget real time for this; it is the single most confusing part
> of testing v4 and it blocks the hook tests entirely.
>
> Test the permission decoder directly as a pure unit, separately from any
> deployed hook: feed it the `0x2044` baseline and assert no anomaly, then feed it
> baseline-plus-`BEFORE_SWAP` and assert it flags. That test needs no deployment
> at all and should be written first.

### Prompt 5 — deploy

> Write `script/Deploy.s.sol` to deploy Fineness and Simulator to Arc mainnet
> (chain 5042).
>
> Gas is paid in USDC, not ETH. Minimum base fee is 20 Gwei and underpriced
> transactions are **silently dropped** — no error, no receipt. Assert the fee
> floor explicitly and fail loudly rather than hanging.
>
> Print both addresses on success. Note that `explorer.arc.io` is permissioned,
> so verification may not be publicly available — if not, commit build artifacts
> and document the compiler settings for manual reproduction.
>
> Then write `contracts/README.md`: what the oracle does, deployed addresses, a
> worked `cast call` example showing `check()` with a native balance override,
> and the `FinenessReport` struct documented field by field.

### Prompt 6 — indexer

> Build `indexer/` in TypeScript with viem. Arc chain 5042 — define the chain
> manually.
>
> `watch.ts`: subscribe to `Initialize` events on the v4 PoolManager
> (`0x8366a39CC670B4001A1121B8F6A443A643e40951`). **Circle's public RPC has no
> WebSocket** — use the third-party wss endpoint from env. Dedupe by token
> address with a TTL set. Reconnect with exponential backoff; a subscription
> that silently stops delivering is the main failure mode.
>
> `holders.ts`: fold all `Transfer` logs into a balance map and compute top-10
> concentration as a share of circulating supply. Exclude the pool and burn
> addresses — the pool is not a holder.
>
> **`eth_getLogs` is capped at 2000 results.** Exceeding it returns `-32602`
> with a suggested narrower block range in the error message — parse that
> suggestion and follow it. Implement adaptive chunking from the first query;
> roughly 40 blocks per chunk at current activity. A single wide range will fail
> every time.
>
> Clamp that suggested range against a freshly read head before retrying. The
> hint is computed against the node's head at the moment of the error, so a reused
> hint can point past current head and come back `-32014 requested data not
> available` — which looks like missing history and is not. Deep history works
> fine.
>
> Exclude the PoolManager address from holder sets — in v4 all liquidity across
> every pool sits in that one singleton, so it is one exclusion, not one per pair,
> and it will otherwise dominate every concentration figure on the chain.
>
> Make the concentration verdict market-cap-aware, not a flat 20% threshold.
> Below ~15k market cap return the raw percentage with verdict
> `INSUFFICIENT_DATA` — a token minutes old is naturally concentrated and
> flagging it is a false positive. Above that, scale toward 20%. Thresholds in
> config, not inline constants.
>
> Derive token age from **block numbers, not timestamps** — Arc block timestamps
> are non-decreasing but not strictly increasing, and sub-second blocks can share
> one.
>
> Bounded concurrency (~20 in flight). Track queue depth; drop events older than
> 60 seconds rather than letting the backlog grow.

### Prompt 7 — api

> Build `api/` as a thin Fastify service over the indexer's SQLite database.
>
> `GET /tokens` — discovered tokens with cached reports, filterable by minimum
> market cap (default 5k) and maximum top-10 concentration.
> `GET /tokens/:address` — full report; if cached report is older than 5 minutes,
> re-run `check()` via `eth_call` with the native balance override and cache.
> `WS /stream` — push newly discovered tokens passing the filters.
>
> Never expose a private key or sign anything. Read-only.

### Prompt 7b — context layer

> Add a context service to `api/` gathering non-verifiable information for
> display. This is explicitly **not** part of the verdict and must never affect
> the score.
>
> Gather: name, symbol, description from token metadata; social links, flagged
> if they fail to resolve; X account creation date and rename history (recycled
> handles are a known scam pattern); and from the indexer, other tokens deployed
> by the same wallet and what happened to them.
>
> - Fetch lazily, detail endpoint only. Never per-row in the feed.
> - Cache aggressively — the X API is paid and rate-limited.
> - **Fail soft.** Hard timeout. If any source is slow or down, return the risk
>   report with context empty or partial. A hanging social fetch must never block
>   a verdict already computed.
>
> Return context as a separate top-level object, not merged into the report.

### Prompt 8 — frontend

> Build `web/` in Next.js. This is the demo, not the product — keep it tight.
> Read `DESIGN.md` in the repo root first.
>
> Arc chain 5042 — define manually for wagmi/viem, it's not in `viem/chains`.
>
> Four screens: connect wallet; bridge USDC in using `@circle-fin/bridge-kit`;
> a candidate feed (fineness mark, name, market cap, liquidity, age, top-10
> share; adjustable MC floor defaulting to 5k); and an assay report.
>
> The report splits into two visually distinct sections:
>
> **Verified** — the on-chain checks, each with pass/fail and reasoning. Drives
> the verdict.
>
> **Context** — socials, description, X age, dev history. No badges, no score,
> no pass/fail styling. Label it clearly as unverified facts. Where
> concentration returns `INSUFFICIENT_DATA`, show the raw number and say plainly
> the token is too young to judge.
>
> Buy panel: amount in USDC, slippage, buy button **disabled on a failed
> verdict** with the reason stated. Design the disabled state as deliberate and
> protective, not broken.
>
> Two Arc-specific states to design, not error-handle:
> - USDC is the gas token, so a wallet with zero USDC cannot transact at all —
>   including to fund itself. Detect and surface a faucet/paymaster path.
> - Transactions under 20 Gwei are silently dropped with no receipt. This
>   presents as a hang. Assert the floor client-side and show a real message.
>
> The context section must render even when its data is missing.

### Prompt 9 — submission

> Write the root `README.md` for grant reviewers: the problem (Arc terminals show
> metrics but return no verdict), the solution, deployed mainnet addresses, a
> Mermaid architecture diagram, local setup, and an integration example showing
> how a third-party terminal would call `check()`.
>
> Frame it as pre-trade risk verification infrastructure for Arc, including for
> autonomous agents transacting on-chain. Do not use the word "degen".
>
> Include a section on the verdict/context split: the oracle scores only what is
> deterministically verifiable on-chain, and deliberately displays socials and
> narrative without scoring them, because a deployer can fabricate those freely.
> A design choice, not a gap.
>
> Include a short "Findings from Arc mainnet" section documenting what we hit
> first-hand: squatted canonical Uniswap addresses holding dead bytecode that
> pass naive liveness checks; the silent 20 Gwei fee floor; no tracing RPCs; the
> 2000-result `eth_getLogs` cap and its range hints that can point past head;
> native and ERC-20 USDC sharing a balance; USDC appearing in `PoolKey` as
> `0x3600…` rather than the v4 native convention; and USDC being `currency0` in
> only 75% of pools. This is useful to other Arc builders and evidences real
> deployment.
>
> Lead that section with the pool survey: 4,156 pools, 95% carrying a hook, 3,823
> distinct hook addresses, permissions clustering on `0x2044`. That survey is the
> evidence base for the product's main check and it is the most novel thing here.
>
> Explain the two design decisions that a reviewer will otherwise read as gaps:
> - **No LP-burn check.** v4 has no LP ERC-20, liquidity is an ERC-721 position,
>   and Arc forbids zero-address transfers. Hook permission decoding replaces it.
> - **Hook presence is not scored, hook permissions are.** 95% of Arc pools have
>   a hook, so presence is meaningless; the low 14 bits of the hook address encode
>   what it may actually do, and deviation from the ecosystem baseline is the
>   signal. Note that no other Arc tooling does this.
>
> Also state plainly that `check()` is designed to be called through `eth_call`
> with a state override. It performs a real round-trip swap, so on-chain
> integration would cost real USDC and move the price. Off-chain integration is
> the supported path.
>
> Then write a 90-second demo script: bridge USDC in, feed populates, open a
> token failing the honeypot check with the buy button disabled, open one that
> passes, execute the buy.

---

## 10. Live risks

**Empty chain.** ~~Blocking concern.~~ **Largely retired** — 4,156 pools exist and
PoolManager emits 300+ logs per 50 blocks. The demo can run on real data. What
remains is a *quality* question: whether any token on Arc actually exhibits the
adversarial behaviour the oracle detects. A chain full of honest launchpad tokens
means the honeypot check never fires on camera. Plan the demo around a mock
deployed by you and labelled as such, rather than hoping to find a live scam.

**PoolKey representation.** ~~Blocking.~~ **Resolved** — `0x3600…`, see §4.

**aka.fun addresses.** Still unpublished, but now largely moot: its pools are
identifiable by the `0x2044` hook permission signature without needing any
published address.

**The hook baseline is an empirical observation, not a spec.** `0x2044` is what
4,156 pools looked like on 17 Sep 2026, four days into a chain's life. If a second
launchpad arrives with different permissions, "anomalous" starts flagging honest
tokens. Keep the baseline in config, re-survey before submission, and say in the
README that it is measured rather than canonical.

**No tracing.** If the v4 callback misbehaves you have events and nothing else.
Instrument heavily from line one.

**RPC rate limits undocumented.** Find them by hitting them, early, not during
the demo.

**X API dependency.** Paid, rate-limited, breakable mid-demo. Built last so it
can be dropped. The app must be fully usable without it.

**Scope creep.** Every cut filter is time bought for making `check()` correct.
The contract is what's judged.