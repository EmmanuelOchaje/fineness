# Fineness

**Pre-trade risk verification for Arc.** A permissionless oracle that answers one
question about a newly launched token — *is this safe to buy?* — and is explicit
about what it will and will not claim to know.

> Status: contracts built and **verified against live Arc mainnet**. Not yet
> deployed. See [Current status](#current-status).

---

## The problem

Arc launched on 16 September 2026 with terminals already shipping. They display
metrics — market cap, liquidity, top-10 share — and leave the judgement to you.
None of them return a verdict.

Meanwhile the chain is filling fast: **130,462 pools** in the window we surveyed,
four days in. At that rate, reading five dashboards per token is not a strategy.

## The approach

Fineness executes a **real buy and a real sell** against the token's pool inside
an `eth_call`, then reports what actually happened. Not heuristics over metadata —
an actual round trip, with the money movement measured.

```
poolManager.unlock()
  └─ buy  USDC → token    measure what the pool credits vs. what arrives
  └─ sell token → USDC    measure the same on the way out
```

If the sell fails, it is a honeypot, and you know because we tried. Nothing is
deployed during a check, nothing is spent, and no key is involved.

---

## Verdict vs. context

The product's central discipline.

| | |
|---|---|
| **Verified** | Deterministic on-chain checks. Machine-decidable, impossible for a deployer to fake. **This earns the score.** |
| **Context** | Socials, X account age, dev history. Shown so a trader has one screen instead of four tabs. **Never scored.** |

Narrative is the cheapest thing in crypto to fabricate. Scoring it would make the
verdict less trustworthy by association. Showing it costs nothing and saves four
browser tabs. This is a design choice, not a missing feature.

---

## What it checks

| Check | How |
|---|---|
| Honeypot | Real USDC → token → USDC round trip |
| Token transfer tax | Pool-credited delta vs. actual balance change, per leg |
| Pool fee / hook fee | Round-trip loss decomposed into its three real sources |
| Ownership renounced | `owner() == address(0)`, try/catch — absence is not a fault |
| Upgradeability | Bytecode scanned for `DELEGATECALL` |
| **Hook permissions** | Low 14 bits of the hook address, compared to the measured ecosystem baseline |
| Dynamic fee | `fee == 0x800000` — the price can move before your trade |
| Holder concentration | Off-chain; market-cap aware (see below) |

### Hook permissions — the part that is genuinely new

Uniswap v4 encodes a hook's permissions in the **low 14 bits of its own address**.
A hook can only exist at an address matching the callbacks it implements, which
makes those permissions tamper-proof and readable with zero external calls.

This matters enormously on Arc, where **91% of pools carry a hook**. Flagging hook
*presence* would flag the entire chain. And with 112,149 distinct hook addresses
across 118,650 hooked pools, an address allowlist is not viable either.

So we measured the ecosystem instead. Across 130,462 pools, permissions cluster
hard:

| Permissions | Pools | Meaning |
|---|---|---|
| `0x2044` | 111,725 (94.2%) | `BEFORE_INITIALIZE \| AFTER_SWAP \| AFTER_SWAP_RETURNS_DELTA` — a per-swap fee hook. **Normal.** |
| `0x20cc` | 3,363 | baseline **+ `BEFORE_SWAP`** |
| `0x2acc` | 1,871 | as above, plus liquidity hooks |

The baseline is standard launchpad behaviour and **costs no score**. What it
lacks is `BEFORE_SWAP` / `BEFORE_SWAP_RETURNS_DELTA` — the permissions that let a
hook block a sell outright or re-price it arbitrarily.

**But we deliberately do not treat that as proof.** 6,392 pools (~5.4%) hold
those permissions, and there are legitimate uses — limit orders, dynamic pricing.
Calling 5% of a chain malicious on a permission bit would repeat exactly the
mistake this check exists to avoid: flagging a population instead of a behaviour.
So it is a heavy deduction, the flag text states a capability rather than an
accusation, and the round trip remains the actual evidence.

As far as we can find, no other Arc tooling does this.

### Two taxes, never one

Because a fee-taking hook is near-universal on Arc, part of every round trip's
cost is the *launchpad's* cut, not the *token's*. Blending them would report
normal venue economics as token malice.

Measured on live pools:

```
unhooked 1% pool   198bps round-trip loss  =  pool fee, and nothing else
hooked   1% pool   778bps                  =  200 pool + 578 hook + 0 token tax
```

Three separate numbers, all the way to the UI.

### "Too early to assay"

Below ~$15k market cap, holder concentration returns `INSUFFICIENT_DATA` rather
than a verdict. A token minutes old is *naturally* concentrated — the early
buyers are the holders. Applying a mature threshold there produces a
confident-looking false positive.

Most tools collapse "we checked and it's fine" into "we couldn't check". That gap
is precisely where a trader gets hurt.

---

## Findings from Arc mainnet

Everything below was hit first-hand while building. Documented for other Arc
builders, since none of it is in the docs.

**Squatted Uniswap addresses.** The canonical v2/v3 addresses (`0x1F98431c…`,
`0xE592427A…`, `0x68b34658…`) all *hold code* on Arc — unrelated Solidity 0.4-era
bytecode that returns empty for every Uniswap method. A `getCode() != "0x"`
liveness check passes and then every call silently returns nothing. Arc is
**Uniswap v4 only**.

**USDC is `0x3600…` in `PoolKey`, not `address(0)`** — despite being the native
gas token. The v4 native-currency convention does not apply.

**USDC is `currency0` in only 74% of pools**, `currency1` in 20%, and absent
entirely in 6%. v4 sorts by address and `0x3600…` sorts mid-range. Hard-coding
direction swaps backwards on a fifth of the chain and returns a plausible number
that is reversed, with no error.

**Native balance and ERC-20 balance are the same balance.** Overriding an
address's native balance changes what `USDC.balanceOf()` returns. This is what
makes keyless, fund-free simulation possible.

**Foundry cannot fork-test Arc's USDC.** Under forked REVM every `transfer`
reverts silently, even to a plain EOA, because the token is protocol-backed. The
identical call on the real RPC returns `true`. Validation has to go through
`eth_call` + state overrides against live RPC.

**20 gwei minimum base fee, silently enforced.** Underpriced transactions are
dropped with no error and no receipt. It presents as a hang, not a failure.

**No tracing.** `debug_traceCall` and `trace_call` both return `-32014`.
Contract-emitted events are the only debugging surface that exists.

**`eth_getLogs` caps at 2000 results**, and the suggested retry range in the
error is computed against that node's head — reuse it later and it can point
*past* head, returning `-32014`, which looks like pruned history and is not.

**Undocumented rate limit** (`-32005`). Not mentioned anywhere in the docs.

**No WebSocket on Circle's public RPC.** Alchemy, Blockdaemon or QuickNode only.

**Block timestamps are non-decreasing, not strictly increasing.** Order by block
number.

---

## Deliberate omissions

**No LP-burn check.** v4 has no LP ERC-20 to burn — liquidity is an ERC-721
position in PositionManager — and Arc forbids zero-address transfers, so only
`0x…dead` is a usable sink. Redefining it as position-NFT lock state is the most
expensive check to get right for the least signal. Hook permission decoding
replaces it.

**Proxy admin is checked off-chain.** Solidity cannot read another contract's
storage, so the EIP-1967 admin slot cannot be read from within the oracle. What
*is* provable on-chain is whether the bytecode can `DELEGATECALL` at all, which
is reported as a possibility rather than a verdict. The precise slot read belongs
to the API layer via `eth_getStorageAt`.

**No blacklist check yet.** Simulating a sell from a second fresh address would
catch tokens that blacklist selectively — a blacklisting token passes a
single-address round trip cleanly. Cut for time; first thing to restore.

A stated, reasoned omission reads better than a half-working check.

---

## Integration

`check()` is designed to be called through `eth_call` with a state override:

```jsonc
eth_call([
  { "to": "<Fineness>", "data": "<check(key, amount)>" },
  "latest",
  { "<Simulator>": { "balance": "0x56bc75e2d63100000" } }   // 100 USDC
])
```

**It performs a real swap.** Through `eth_call` that is free and harmless; called
on-chain from another contract it would spend real USDC and move the price.
Integration is off-chain, by design — including for autonomous agents that need a
pre-trade check before committing funds.

---

## Repo layout

```
shared/      chain constants + hook permission decoder (pure, unit-tested)
contracts/   Foundry. Simulator.sol, Fineness.sol, HookPermissions.sol
indexer/     pool discovery, holder folding, live verification harness
api/         read-only service (in progress)
web/         demo frontend (not started — see build order)
```

## Running it

```bash
pnpm install
pnpm --filter @fineness/shared test        # hook decoder, 8 tests
cd contracts && forge test                 # 10 tests incl. fuzz

pnpm --filter @fineness/indexer survey        # re-measure the hook baseline
pnpm --filter @fineness/indexer find-pools    # find pools with real liquidity
pnpm --filter @fineness/indexer verify-live   # run the oracle on live mainnet
```

`verify-live` is the interesting one: it injects the compiled contracts into a
live `eth_call` and runs a genuine round trip against real pools, without
deploying anything.

---

## Current status

Built and verified, **not yet deployed**.

- ✅ Contracts compile, 10 tests pass including fuzz
- ✅ Hook decoder cross-implemented in Solidity and TypeScript, same fixtures
- ✅ Full `check()` validated against live Arc mainnet on real pools
- ✅ Pool discovery, chunked log scanning, holder concentration
- ⬜ Mainnet deployment
- ⬜ API service
- ⬜ Demo frontend

## Honest caveats

**The hook baseline is measured, not canonical.** `0x2044` is what 130,462 pools
looked like on 17 September 2026, four days into a chain's life. A second
launchpad with different permissions would make "anomalous" start flagging honest
tokens. It is mutable config, the survey is a committed re-runnable script, and
it should be re-measured before submission.

**Hook permission bit positions** were reverse-derived from observed addresses
and are consistent across the whole survey, but should be confirmed against
v4-core `Hooks.sol` before anyone trusts a score with money.

**The fork test fixtures are live addresses on a young chain.** They will rot.
Re-run `find-pools` rather than debugging a stale fixture.

**We have not yet found a real honeypot on Arc to demonstrate against.** Every
pool tested so far sells cleanly. The honeypot path is exercised by construction
and by mocks, but a live example would be better evidence.
