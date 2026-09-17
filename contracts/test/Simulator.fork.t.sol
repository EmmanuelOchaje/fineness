// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Simulator} from "../src/Simulator.sol";
import {Fineness} from "../src/Fineness.sol";
import {IPoolManager, IERC20Minimal, PoolKey, Currency} from "../src/interfaces/IPoolManager.sol";

/**
 * Fork tests against live Arc mainnet state.
 *
 *   forge test --match-path test/Simulator.fork.t.sol --fork-url $ARC_RPC_URL -vv
 *
 * The pools below were selected by `pnpm --filter fineness/indexer find-pools`,
 * which ranks pools by recent Swap events. That matters: a pool that was
 * initialized but never funded makes the Simulator revert for reasons that have
 * nothing to do with token risk, and mistaking one for the other is exactly the
 * failure this project exists to avoid.
 *
 * These are live addresses on a chain days old. They will rot. Re-run find-pools
 * and replace them rather than debugging a stale fixture.
 */
contract SimulatorForkTest is Test {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant USDC = 0x3600000000000000000000000000000000000000;

    Simulator simulator;
    Fineness fineness;

    // Liquid pool, standard launchpad hook (permissions 0x2044 — the norm).
    address constant TOKEN_HOOKED = 0x5c11D8B3d09EEFb2c3A8506082a5F1567Ada95fb;
    address constant HOOK_BASELINE = 0x69a79Ab259ea7Ef2e68F64c8fa2b1AD16723E044;

    // Liquid pool with NO hook at all — the ~9% case, useful as a control.
    address constant TOKEN_NO_HOOK = 0x5eec40846a60a476b6E87B0eEAf43F119A70dF2C;

    function setUp() public {
        // Skips cleanly when no fork URL is configured, so `forge test` stays
        // green offline and in CI without secrets.
        try vm.envString("ARC_RPC_URL") returns (string memory url) {
            vm.createSelectFork(url);
        } catch {
            return;
        }
        simulator = new Simulator();
        fineness = new Fineness();
    }

    modifier onlyFork() {
        if (address(simulator) == address(0)) return;
        if (block.chainid != 5042) return;
        _;
    }

    function _key(address token, address hook) internal pure returns (PoolKey memory) {
        // v4 sorts currencies by address. USDC at 0x3600... sorts mid-range, so
        // which side it lands on genuinely varies — never assume.
        (address c0, address c1) = USDC < token ? (USDC, token) : (token, USDC);
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 10000,
            tickSpacing: 200,
            hooks: hook
        });
    }

    /**
     * The load-bearing assumption of the entire design: on Arc, overriding an
     * address's NATIVE balance also funds its USDC ERC-20 balance, because they
     * are the same balance. If this fails, the Simulator needs real money and
     * the whole "free, keyless simulation" premise collapses.
     */
    function test_nativeBalanceFundsUsdc() public onlyFork {
        vm.deal(address(simulator), 1e18); // 1 USDC at 18-decimal internal precision
        uint256 erc20 = IERC20Minimal(USDC).balanceOf(address(simulator));
        console.log("native-funded USDC balance (6dp):", erc20);
        assertGt(erc20, 0, "native balance did not fund the USDC ERC-20 interface");
    }

    function test_roundTripOnHookedPool() public onlyFork {
        vm.deal(address(simulator), 100e18); // 100 USDC
        PoolKey memory key = _key(TOKEN_HOOKED, HOOK_BASELINE);

        Simulator.SimResult memory r = simulator.simulate(key, 1_000_000); // 1 USDC

        console.log("usdcSent       ", r.usdcSent);
        console.log("usdcCredited   ", r.usdcCredited);
        console.log("tokensFromPool ", r.tokensFromPool);
        console.log("tokensReceived ", r.tokensReceived);
        console.log("sellSucceeded  ", r.sellSucceeded);
        console.log("usdcReceived   ", r.usdcReceived);
        if (!r.sellSucceeded) console.log("failureReason  ", r.failureReason);

        assertTrue(r.buySucceeded, "buy leg failed on a pool with live liquidity");
        assertGt(r.tokensReceived, 0, "received no tokens");
    }

    function test_roundTripOnUnhookedPool() public onlyFork {
        vm.deal(address(simulator), 100e18);
        PoolKey memory key = _key(TOKEN_NO_HOOK, address(0));

        Simulator.SimResult memory r = simulator.simulate(key, 1_000_000);
        console.log("no-hook pool | tokens:", r.tokensReceived, "sold:", r.sellSucceeded);
        assertTrue(r.buySucceeded);
    }

    /// A pool with no USDC on either side must be rejected by name, not guessed at.
    function test_rejectsPoolWithoutUsdc() public onlyFork {
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(TOKEN_NO_HOOK),
            currency1: Currency.wrap(TOKEN_HOOKED),
            fee: 10000,
            tickSpacing: 200,
            hooks: address(0)
        });
        vm.expectRevert();
        simulator.simulate(key, 1_000_000);
    }

    function test_fullReportOnLivePool() public onlyFork {
        vm.deal(address(simulator), 100e18);
        Fineness.Report memory rep = fineness.check(_key(TOKEN_HOOKED, HOOK_BASELINE), 1_000_000);

        console.log("token            ", rep.token);
        console.log("score            ", rep.score);
        console.log("isHoneypot       ", rep.isHoneypot);
        console.log("buyTaxBps        ", rep.buyTaxBps);
        console.log("sellTaxBps       ", rep.sellTaxBps);
        console.log("poolFeeBps       ", rep.poolFeeBps);
        console.log("hookFeeBps       ", rep.hookFeeBps);
        console.log("hookPermissions  ", rep.hookPermissions);
        console.log("ownershipRenounced", rep.ownershipRenounced);
        console.log("mayBeUpgradeable ", rep.mayBeUpgradeable);
        for (uint256 i; i < rep.flags.length; ++i) {
            console.log("  flag:", rep.flags[i]);
        }

        assertEq(rep.token, TOKEN_HOOKED);
        // The baseline hook is the ecosystem norm and must not be called dangerous.
        assertFalse(rep.hookCanInterceptSwap, "baseline hook wrongly flagged as interceptor");
    }
}
