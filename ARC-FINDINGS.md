# Arc Mainnet — Prompt 0 Findings

Verified against live Arc mainnet on **17 Sep 2026** (chain one day old). Everything
below was confirmed by direct RPC call, not read from docs, except where marked
*(docs only)*. Re-verify before relying on any of it — this chain is moving.

Docs moved: `docs.arc.network` → **`docs.arc.io`**.

---

## Network

| | |
|---|---|
| Chain ID | `5042` (`0x13b2`) |
| Client | `arc/v1` |
| Primary RPC | `https://rpc.mainnet.arc.io` (public, no key) |
| Head at time of check | ~21,389,761 |
| Explorer | `explorer.arc.io` — **permissioned access**, not publicly browsable |
| Gas token | USDC |

**No WebSocket on Circle's own endpoint.** Only Alchemy, Blockdaemon and QuickNode
expose `wss://`. The indexer's `watchEvent` pair subscription requires a
third-party provider and an API key. Budget for this.

---

## The load-bearing question: state overrides

**Supported.** All three forms verified working on mainnet `eth_call`:

- `balance` override ✅
- `code` override ✅ — injected bytecode executed and returned its value
- `stateDiff` storage override ✅

**Bonus finding that simplifies the Simulator:** native and ERC-20 USDC share one
balance. Overriding an address's *native* balance to `0xde0b6b3a7640000` (1e18
internal) made the USDC ERC-20 `balanceOf` return `1000000` (1 USDC at 6 decimals).

So the simulator is funded by a single `balance` override. **The pre-funded
fallback (option 2 in the build plan) is unnecessary — drop it.**

### No tracing

`debug_traceCall` and `trace_call` both return `-32014 requested data not
available`. There is no tracing fallback if simulation misbehaves; instrument the
Simulator contract itself.

---

## Deployed contracts

### Circle / Arc core *(docs only, spot-checked)*

| Contract | Address |
|---|---|
| USDC (native + ERC-20 iface) | `0x3600000000000000000000000000000000000000` |
| EURC | `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| CREATE2 Factory | `0x4e59b44847b379578588920cA78FbF26c0B4956C` |
| TokenMessengerV2 (CCTP) | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` |

### Uniswap — **v4 only**

Verified on-chain. `PositionManager.poolManager()` returns the PoolManager
address, so the set is self-consistent.

| Contract | Address | Code |
|---|---|---|
| v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | 24,009 B |
| UniversalRouter | `0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1` | 24,546 B |
| v4 PositionManager | `0x6049c9a0e26405C0985f9E3685C87d0aE917f82B` | 23,877 B |
| v4 Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` | 6,118 B |

PoolManager owner: `0xbca30b5429935205037069cf5b8a165f55d05a75`.

### ⚠️ Canonical Uniswap addresses are squatted — do not use

`0x1F98431c...` (v3 Factory), `0xE592427A...` (SwapRouter) and `0x68b34658...`
(SwapRouter02) **all hold code on Arc**, but it is unrelated Solidity 0.4-era
bytecode. `factory()`, `owner()` and `feeAmountTickSpacing()` all return empty
`0x`. A naive `getCode() != "0x"` liveness check passes and then every call
silently returns nothing.

Canonical v2 factory/router and the canonical v4 PoolManager/UniversalRouter
addresses from other chains are genuinely empty.

**aka.fun launchpad addresses could not be found** — not in Arc docs, not
published anywhere searchable. Needs a first-hand source.

---

## Consequences for the build plan

### 1. Simulator must be written against v4, not a V2/V3 router

v4 is a singleton with an unlock/callback pattern. There is no
`swapExactTokensForTokens`. The Simulator must either:

- call `poolManager.unlock(data)`, implement `unlockCallback`, call
  `poolManager.swap(key, params, hookData)` inside it, then `settle`/`take`; or
- encode a UniversalRouter command sequence with Permit2.

Direct PoolManager is fewer moving parts for a round-trip simulation and avoids
Permit2 signature plumbing. Prefer it.

**Resolved by the pool survey below:** USDC is `0x3600…` in `PoolKey`, and it is
`currency0` in only 74% of pools — derive `zeroForOne` per pool.

Hooks also matter: a v4 pool can attach a hook that blocks or taxes swaps, a
honeypot vector with no v2/v3 equivalent. But on Arc 95% of pools have one, so
*presence* proves nothing — decode the permission bits instead. See the survey.

### 2. The LP-burn check does not translate to v4

The plan defines `lpBurnedBps` as LP-token balance at `0xdead` / LP total supply.
**v4 has no LP ERC-20.** Liquidity is an ERC-721 position held in PositionManager.

**Decided: dropped.** Redefining it as position-NFT lock state is the most
expensive check to get right for the least signal. Hook permission decoding
replaces it. Stated plainly in the README.

Also note Arc **forbids transfers to the zero address**, so `address(0)` cannot
accumulate burned anything — only `0x…dead` is a usable burn sink.

### 3. `eth_getLogs` is capped at 2000 results

Exceeding it returns `-32602` *and a suggested narrower block range in the error
message* — parse and follow it. At current activity 2000 results spans roughly 40
blocks, so `holders.ts` folding all `Transfer` logs from pair creation to head
needs chunked pagination with backoff from block one. A single wide range query
will fail every time.

### 4. Fee floor is a silent failure mode

Minimum base fee is 20 Gwei and **transactions below it are silently dropped by
the mempool** — no error, no receipt. During the demo this looks like a hang, not
a failure. Set and assert a floor explicitly in both the deploy script and the
frontend.

---

## Other EVM differences *(docs only)*

- `PREVRANDAO` → `0`; no on-chain randomness
- `BLOBHASH` → `0`, `BLOBBASEFEE` → `1`; EIP-4844 type-3 txs rejected by mempool
- Base fee paid to block beneficiary, not burned
- Next block's base fee published in parent header `extra_data`
- Block timestamps non-decreasing, **not strictly increasing** — sub-second
  blocks may share a timestamp. Anything deriving token *age* from timestamps
  must tolerate equal values; use block numbers where ordering matters.
- Deterministic instant finality on inclusion — no confirmation counting
- Runtime blocklist enforced at the protocol level
- `SELFDESTRUCT` per EIP-6780 plus native-value rules; non-zero-value calls to
  self-destructed accounts revert

---

## Pool survey — 130,462 `Initialize` events decoded, 17 Sep 2026

`Initialize` topic0:
`0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438`
(`currency0`/`currency1` are indexed topics 2 and 3; `fee`, `tickSpacing`,
`hooks`, `sqrtPriceX96`, `tick` are packed in `data`.)

Reproduce with `pnpm --filter @fineness/indexer survey`. Window: 250,000 blocks
back from head 21,379,167.

| | |
|---|---|
| Pools | **130,462** — the chain is emphatically not empty |
| Fee tier | `10000` (1%) on 88%; 459 pools use `0x800000` (dynamic-fee flag) |
| USDC as `currency0` | 74.0% (96,521) |
| USDC as `currency1` | 19.6% (25,618) |
| No USDC at all | 6.4% (8,323 token/token pools — unassayable) |
| Non-zero hook | 90.9% (118,650) |
| Distinct hook addresses | 112,149 — nearly one per pool |

**USDC is `0x3600…` in `PoolKey`, not `address(0)`.** The v4 native-currency
convention does not apply on Arc even though USDC is the native asset.

**USDC is not reliably `currency0`.** v4 sorts by address and `0x3600…` sorts
mid-range. `zeroForOne` must be derived per pool.

**Hook permissions cluster hard on one value.** v4 encodes permissions in the low
14 bits of the hook's address. The distribution across 118,650 hooked pools:

| Permissions | Pools | Meaning |
|---|---|---|
| `0x2044` | 111,725 (94.2%) | `BEFORE_INITIALIZE \| AFTER_SWAP \| AFTER_SWAP_RETURNS_DELTA` — **baseline** |
| `0x20cc` | 3,363 | baseline **+ `BEFORE_SWAP` + `BEFORE_SWAP_RETURNS_DELTA`** |
| `0x2acc` | 1,871 | as above, plus liquidity hooks |
| `0x04cc` | 301 | before-swap family, no `BEFORE_INITIALIZE` |
| `0x2544` | 292 | baseline + liquidity hooks (harmless) |

The baseline is a per-swap fee-taking hook — the standard launchpad pattern,
consistent with aka.fun's documented trading fee. **It is the norm, not a red
flag**, and must not cost score.

**⚠️ Correction to the earlier small-sample read.** The first 4,156-pool sample
suggested swap-intercepting hooks were vanishingly rare. At full scale they are
not: **6,392 pools (~5.4% of hooked pools) carry `BEFORE_SWAP`**, which lets a
hook block or re-price a sell.

That is far too large a population to presume malicious, and there are legitimate
uses (limit orders, dynamic pricing). So `BEFORE_SWAP` is a **heavy score
deduction, not an automatic zero** — the behavioural round trip remains the
actual proof of a honeypot. Treating a 5% population as guilty would repeat
precisely the mistake this check was built to avoid.

**Some hooks are reused across many pools.** `0x20eead…6acc` appears repeatedly.
Address-level reputation is therefore viable as a *future* addition for the
recurring minority, but cannot be the primary mechanism at 112,149 distinct
addresses.

*Caveat:* the bit-position ordering above was derived from observed addresses.
Confirm against v4-core `Hooks.sol` before implementing. And `0x2044` is an
empirical baseline from a four-day-old chain, not a spec — re-survey before
relying on it.

---

## Still unresolved

- aka.fun launchpad addresses — still unpublished, but largely moot: its pools
  are identifiable by the `0x2044` hook signature
- Whether any token on Arc exhibits genuinely adversarial behaviour yet. Pools
  exist in quantity; honeypots to demo against may not.
- RPC rate limits are undocumented
