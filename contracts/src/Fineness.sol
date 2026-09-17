// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Simulator} from "./Simulator.sol";
import {HookPermissions} from "./HookPermissions.sol";
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
    Simulator public constant simulator = Simulator(0x880067680E32b27644ea82B62969eF074Fd85093);
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

    struct Report {
        address token;
        // --- the verdict ---
        bool isHoneypot;
        uint16 score; // 0-1000, rendered as a fineness mark (.999 / .500 / .000)
        // --- taxes, kept separate on purpose ---
        uint16 buyTaxBps; // the TOKEN's transfer tax on the way in
        uint16 sellTaxBps; // the TOKEN's transfer tax on the way out
        uint16 roundTripLossBps; // total cost of a round trip
        uint16 poolFeeBps; // the pool's own fee tier, both legs
        uint16 hookFeeBps; // the HOOK's cut - launchpad economics, not the token's
        // --- authority ---
        bool hasOwnerFunction;
        bool ownershipRenounced;
        bool mayBeUpgradeable;
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

        // ---- 2. authority -------------------------------------------------
        (report.hasOwnerFunction, report.ownershipRenounced) = _checkOwner(report.token);
        if (report.hasOwnerFunction && !report.ownershipRenounced) {
            flags[n++] = "OWNERSHIP NOT RENOUNCED";
        }

        // NOTE: Solidity cannot read another contract's storage, so the EIP-1967
        // admin slot cannot be read from here — that check runs off-chain via
        // eth_getStorageAt in the API layer. What IS provable on-chain is
        // whether the token's bytecode can delegatecall at all. A contract that
        // cannot delegatecall cannot be a proxy; one that can is worth a closer
        // look. Reported as a possibility, never as a verdict.
        report.mayBeUpgradeable = _containsDelegatecall(report.token);
        if (report.mayBeUpgradeable) {
            flags[n++] = "MAY BE UPGRADEABLE - verify proxy admin off-chain";
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
        report.score = _score(report);

        string[] memory trimmed = new string[](n);
        for (uint256 i; i < n; ++i) {
            trimmed[i] = flags[i];
        }
        report.flags = trimmed;
    }

    /**
     * 0-1000, rendered as a fineness mark. Deductions are deliberately blunt:
     * a mark that is hard to explain is a mark nobody trusts.
     */
    function _score(Report memory r) internal pure returns (uint16) {
        if (r.isHoneypot) return 0; // cannot sell: nothing else matters

        uint256 s = 1000;

        uint256 tax = uint256(r.buyTaxBps) + uint256(r.sellTaxBps);
        if (tax >= 2000) return 0; // >20% combined is predatory, full stop
        s -= tax > 500 ? 400 : (tax * 400) / 500;

        // A swap-intercepting hook is a heavy deduction, NOT an automatic zero.
        //
        // Measured across 121k Arc pools, ~5% carry BEFORE_SWAP permissions —
        // that is 6,392 pools, far too many to be presumed malicious, and there
        // are legitimate reasons to hold it (limit orders, dynamic pricing).
        // Zeroing them all would repeat exactly the mistake this check was built
        // to avoid: flagging a population instead of a behaviour.
        //
        // The round trip above is the actual proof. If the hook blocks selling,
        // `isHoneypot` already returned 0 on its own evidence. This deduction
        // says only "this pool COULD be turned into a honeypot by its operator
        // without redeploying" — which is worth knowing and worth pricing, but
        // is not the same claim.
        if (r.hookCanInterceptSwap) s -= 350;
        else if (r.hookBeyondBaseline != 0) s -= 100;

        if (r.hasOwnerFunction && !r.ownershipRenounced) s -= 250;
        if (r.mayBeUpgradeable) s -= 150;
        if (r.dynamicFee) s -= 50;

        return uint16(s);
    }

    /// @dev try/catch because plenty of legitimate tokens expose no `owner()`.
    ///      Absence is not a fault; it is simply a different shape of contract.
    function _checkOwner(address token) internal view returns (bool has, bool renounced) {
        (bool ok, bytes memory data) =
            token.staticcall(abi.encodeWithSignature("owner()"));
        if (!ok || data.length < 32) return (false, false);
        return (true, abi.decode(data, (address)) == address(0));
    }

    /**
     * Scan the token's bytecode for DELEGATECALL (0xf4).
     *
     * A heuristic, and labelled as one. It over-reports: 0xf4 can appear inside
     * PUSH data rather than as an opcode, and plenty of non-proxy contracts
     * delegatecall legitimately. It does not under-report, which is the
     * direction that matters here — a contract with no DELEGATECALL in its code
     * cannot be an upgradeable proxy.
     */
    function _containsDelegatecall(address target) internal view returns (bool) {
        uint256 size;
        assembly {
            size := extcodesize(target)
        }
        if (size == 0) return false;

        bytes memory code = new bytes(size);
        assembly {
            extcodecopy(target, add(code, 0x20), 0, size)
        }
        for (uint256 i; i < size; ++i) {
            if (code[i] == 0xf4) return true;
        }
        return false;
    }

    function _bps(uint256 part, uint256 whole) internal pure returns (uint16) {
        if (whole == 0) return 0;
        uint256 v = (part * 10_000) / whole;
        return v > type(uint16).max ? type(uint16).max : uint16(v);
    }
}
