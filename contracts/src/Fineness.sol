// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Simulator} from "./Simulator.sol";
import {HookPermissions} from "./HookPermissions.sol";
import {Authority} from "./Authority.sol";
import {IPoolManager, IERC20Minimal, PoolKey, Currency} from "./interfaces/IPoolManager.sol";

/**
 * Fineness — pre-trade risk verification for Arc.
 *
 * Returns a verdict, not a dashboard. Everything reported here is
 * deterministically verifiable on-chain and cannot be faked by the token's
 * deployer. Socials, narrative and dev history are deliberately absent: they are
 * trivially fabricated, and scoring them would make this verdict less
 * trustworthy by association. The frontend shows them, clearly unscored.
 *
 * ## How to call this
 *
 * Through `eth_call` with a state override funding the Simulator:
 *
 *   eth_call({to: fineness, data: check(...)}, "latest",
 *            {<simulator>: {balance: "0xde0b6b3a7640000"}})
 *
 * On Arc, native balance and USDC ERC-20 balance are the same balance, so that
 * single override funds the round trip. Nothing persists and no gas is paid.
 *
 * Calling `check()` in a real transaction would execute a genuine swap, spend
 * real USDC and move the price. Integration is off-chain, by design.
 */
contract Fineness {
    using HookPermissions for address;

    /**
     * @dev Same reasoning as Simulator: constants keep the deployed bytecode
     *      self-contained so it can be injected via an eth_call code override.
     *
     *      The Simulator address is deterministic — deployed by CREATE2 with
     *      salt keccak256("fineness.simulator.v1") through the standard factory
     *      at 0x4e59b448..., so it is computable before deployment and identical
     *      on any chain. The deploy script asserts the match and refuses to
     *      proceed if Simulator's bytecode changed without this being updated.
     */
    Simulator public constant simulator = Simulator(0x7bf235ff217D11CF629367FF7be5533F49a44408);
    address public constant usdc = 0x3600000000000000000000000000000000000000;

    /**
     * @notice Hook baseline as mutable config, because it is an empirical
     *         measurement of a days-old chain rather than a spec.
     *
     * @dev Deliberately NOT initialized at the declaration. A declaration
     *      initializer runs in the constructor, and this contract is designed to
     *      be injected into an `eth_call` via a code override — where no
     *      constructor ever runs and all storage reads as zero.
     *
     *      Without the fallback in `baseline()`, an injected call would compare
     *      every hook against a baseline of 0 and flag 94% of the chain as
     *      anomalous. That bug shipped for exactly one test run and was caught
     *      by live verification; keep the fallback.
     */
    uint16 public hookBaseline;

    /// @notice The effective baseline. Zero storage means "never configured".
    function baseline() public view returns (uint16) {
        return hookBaseline == 0 ? HookPermissions.ARC_BASELINE : hookBaseline;
    }
    address public owner;

    uint24 internal constant DYNAMIC_FEE_FLAG = 0x800000;

    /**
     * Exit-cost thresholds, in bps of a round trip.
     *
     * Measured across live Arc pools the spread is enormous — 60bps at the
     * cheapest to over 6000bps at the worst — so this is the single most
     * discriminating number available, and it was previously not scored at all.
     */
    uint16 internal constant EXIT_COST_NOTABLE = 600; // 6%
    uint16 internal constant EXIT_COST_HIGH = 2000; //  20%
    uint16 internal constant EXIT_COST_SEVERE = 5000; // 50%

    struct Report {
        address token;
        // --- the verdict ---
        bool isHoneypot;
        /**
         * The fineness mark, as a discrete standard.
         *
         * Real assay marks are legal standards, not a continuum: silver is .925
         * sterling or it is not; there is no .913. An earlier version returned a
         * weighted 0-1000 score, which manufactured precision the underlying
         * measurements cannot support — the weights were invented and never
         * calibrated against whether a token actually rugged.
         *
         *   3 = .999  sellable, cheap to exit, no privileged powers
         *   2 = .750  sellable, one named issue
         *   1 = .500  sellable but expensive, or the operator retains power
         *   0 = .000  cannot sell, or exiting costs nearly everything
         *
         * Each grade maps to a specific measured fact, in `flags`.
         */
        uint8 grade;
        // --- taxes, kept separate on purpose ---
        uint16 buyTaxBps; // the TOKEN's transfer tax on the way in
        uint16 sellTaxBps; // the TOKEN's transfer tax on the way out
        uint16 roundTripLossBps; // total cost of a round trip
        // Probe results, surfaced so callers can derive a price without a
        // second simulation. price = usdcProbed / tokensOut, and market cap is
        // that times totalSupply. Market cap gates the INSUFFICIENT_DATA rule
        // on holder concentration, so without it the off-chain layer cannot
        // tell "too early to judge" from "not yet computed" — two states that
        // must never be conflated.
        uint256 usdcProbed;
        uint256 tokensOut;
        uint16 poolFeeBps; // the pool's own fee tier, both legs
        uint16 hookFeeBps; // the HOOK's cut - launchpad economics, not the token's
        // --- authority ---
        bool hasOwnerFunction;
        bool ownershipRenounced;
        /** True only for a genuinely replaceable implementation. */
        bool mayBeUpgradeable;
        /** EIP-1167 clone: immutable by construction, and NOT a fault. */
        bool minimalProxy;
        /** An owner exists AND a privileged function exists for it to call. */
        bool ownerHasPowers;
        address implementation;
        // --- the v4-specific checks ---
        address hook;
        uint16 hookPermissions;
        uint16 hookBeyondBaseline;
        bool hookMatchesBaseline;
        bool hookCanInterceptSwap;
        bool hookTakesSwapFee;
        bool dynamicFee;
        // --- human-readable ---
        string[] flags;
    }

    error NotOwner();

    constructor() {
        owner = msg.sender;
    }

    /// @notice Re-point the hook baseline if the ecosystem norm shifts.
    function setHookBaseline(uint16 newBaseline) external {
        if (msg.sender != owner) revert NotOwner();
        hookBaseline = newBaseline;
    }

    function renounceOwnership() external {
        if (msg.sender != owner) revert NotOwner();
        owner = address(0);
    }

    /**
     * @param key        The v4 pool to assay. USDC must be one of its currencies.
     * @param usdcAmount Probe size in USDC (6 decimals). 1_000_000 == 1 USDC.
     *                   Too large on a thin pool and slippage swamps the tax
     *                   signal; too small and rounding does.
     */
    function check(PoolKey calldata key, uint256 usdcAmount)
        external
        returns (Report memory report)
    {
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        report.token = (c0 == usdc) ? c1 : c0;

        string[] memory flags = new string[](12);
        uint256 n;

        report.dynamicFee = key.fee == DYNAMIC_FEE_FLAG;

        // ---- 1. the round trip -------------------------------------------
        Simulator.SimResult memory sim = simulator.simulate(key, usdcAmount);

        report.usdcProbed = sim.usdcSent;
        report.tokensOut = sim.tokensReceived;
        report.isHoneypot = !sim.sellSucceeded;
        if (report.isHoneypot) {
            flags[n++] = string.concat("CANNOT SELL: ", sim.failureReason);
        }

        if (sim.tokensFromPool > 0 && sim.tokensFromPool >= sim.tokensReceived) {
            report.buyTaxBps =
                _bps(sim.tokensFromPool - sim.tokensReceived, sim.tokensFromPool);
        }
        if (sim.sellSucceeded && sim.tokensSent > 0) {
            report.sellTaxBps = _bps(sim.tokensSent - sim.tokensCredited, sim.tokensSent);
            report.roundTripLossBps = sim.usdcReceived < sim.usdcSent
                ? _bps(sim.usdcSent - sim.usdcReceived, sim.usdcSent)
                : 0;

            // Decompose the round-trip loss into its three real sources.
            //
            // `fee` is in hundredths of a bip (1e-6), so fee/100 is bps per leg
            // and a round trip pays it twice. Measured against live Arc pools
            // this lands almost exactly: an UNHOOKED 1% pool loses ~198bps on a
            // round trip, which is the pool fee and nothing else. Hooked pools
            // on the same fee tier lose 440-780bps, and that excess is the hook.
            //
            // Keeping these apart is the point. "This token taxes you 20%",
            // "this venue charges 1%" and "this launchpad skims 6%" are three
            // different warnings, and ~91% of Arc pools charge the last one as a
            // matter of course.
            uint16 tokenPortion = report.buyTaxBps + report.sellTaxBps;
            report.poolFeeBps = report.dynamicFee ? 0 : uint16((uint256(key.fee) * 2) / 100);

            uint256 explained = uint256(tokenPortion) + uint256(report.poolFeeBps);
            report.hookFeeBps = report.roundTripLossBps > explained
                ? uint16(uint256(report.roundTripLossBps) - explained)
                : 0;
        }

        if (report.buyTaxBps >= 1000 || report.sellTaxBps >= 1000) {
            flags[n++] = "TOKEN TAX ABOVE 10%";
        }
        // Exit cost is a first-class finding, not a footnote. A token you can
        // technically sell but only at a 60% loss is closer to a honeypot than
        // to a clean token, and the verdict now says so.
        if (report.roundTripLossBps >= EXIT_COST_SEVERE) {
            flags[n++] = "EXIT COSTS OVER HALF YOUR POSITION";
        } else if (report.roundTripLossBps >= EXIT_COST_HIGH) {
            flags[n++] = "EXPENSIVE TO EXIT";
        }

        // ---- 2. authority -------------------------------------------------
        Authority.Report memory auth = Authority.inspect(report.token);
        report.minimalProxy = auth.minimalProxy;
        report.implementation = auth.implementation;
        report.mayBeUpgradeable = auth.upgradeable;
        report.ownerHasPowers = auth.ownerHasPowers;
        report.hasOwnerFunction = auth.ownerRetained;
        report.ownershipRenounced = !auth.ownerRetained;

        // Only flag an owner that can actually DO something. A bare `owner()`
        // getter with no privileged functions behind it is attribution, not
        // authority, and penalising it flags most of the chain for nothing.
        if (auth.ownerHasPowers) {
            flags[n++] = "OWNER CAN ALTER TOKEN BEHAVIOUR";
        }
        if (auth.upgradeable) {
            flags[n++] = "IMPLEMENTATION MAY BE REPLACEABLE";
        }

        // ---- 3. the v4 checks ---------------------------------------------
        report.hook = key.hooks;
        report.hookPermissions = key.hooks.permissions();
        uint16 base = baseline();
        report.hookBeyondBaseline = key.hooks.beyondBaseline(base);
        report.hookMatchesBaseline =
            key.hooks != address(0) && report.hookPermissions == base;
        report.hookCanInterceptSwap = key.hooks.canInterceptSwap();
        report.hookTakesSwapFee = key.hooks.takesSwapFee();

        // Presence of a hook is NOT a flag — 91% of Arc pools have one. Only a
        // hook that can intercept a swap before it executes earns a warning, and
        // even then the wording is deliberate: it states a capability, not an
        // accusation. ~5% of Arc pools hold this permission legitimately.
        if (report.hookCanInterceptSwap) {
            flags[n++] = "HOOK COULD BLOCK SELLS - sell simulation passed anyway";
        } else if (report.hookBeyondBaseline != 0) {
            flags[n++] = "HOOK PERMISSIONS EXCEED ECOSYSTEM NORM";
        }

        if (report.dynamicFee) {
            flags[n++] = "DYNAMIC FEE - may change before your trade";
        }

        // ---- 4. the mark ---------------------------------------------------
        report.grade = _grade(report);

        string[] memory trimmed = new string[](n);
        for (uint256 i; i < n; ++i) {
            trimmed[i] = flags[i];
        }
        report.flags = trimmed;
    }

    /**
     * The mark.
     *
     * Deliberately discrete and deliberately blunt. Each step is a sentence a
     * trader can act on, and every one of them traces to something measured
     * rather than to a weight somebody chose.
     */
    function _grade(Report memory r) internal pure returns (uint8) {
        // .000 — you cannot get out, or getting out costs nearly everything.
        // Economically these are the same outcome, so they share a grade.
        if (r.isHoneypot) return 0;
        if (r.roundTripLossBps >= EXIT_COST_SEVERE) return 0;
        if (uint256(r.buyTaxBps) + uint256(r.sellTaxBps) >= 2000) return 0;

        // .500 — you can get out, but it is expensive, or somebody retains the
        // power to change the rules after you buy.
        if (r.roundTripLossBps >= EXIT_COST_HIGH) return 1;
        if (r.hookCanInterceptSwap) return 1;
        if (r.ownerHasPowers) return 1;
        if (r.mayBeUpgradeable) return 1;

        // .750 — sellable and reasonably priced, with one thing worth naming.
        if (r.roundTripLossBps >= EXIT_COST_NOTABLE) return 2;
        if (r.dynamicFee) return 2;
        if (r.hookBeyondBaseline != 0) return 2;
        if (uint256(r.buyTaxBps) + uint256(r.sellTaxBps) > 0) return 2;

        // .999 — nothing measured stands against it.
        return 3;
    }

    function _bps(uint256 part, uint256 whole) internal pure returns (uint16) {
        if (whole == 0) return 0;
        uint256 v = (part * 10_000) / whole;
        return v > type(uint16).max ? type(uint16).max : uint16(v);
    }
}
