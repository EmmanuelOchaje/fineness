// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {HookPermissions} from "../src/HookPermissions.sol";

/**
 * The hook permission decoder is the check the whole product rests on, so it is
 * tested as a pure unit: no fork, no deployment, no RPC, no mock hook.
 *
 * That matters practically. A v4 hook only works at an address whose low 14 bits
 * match its declared permissions, so *deploying* a test hook needs
 * `deployCodeTo` at a mined address. Decoding needs none of that — which is why
 * these tests could be written before the rest of the contracts compiled.
 *
 * Mirrors shared/src/hooks.test.ts. Same fixtures, same expectations.
 */
contract HookPermissionsTest is Test {
    using HookPermissions for address;

    // Real hook addresses observed on Arc mainnet, 2026-09-17.
    address constant ARC_HOOK_1 = 0x8f0C88bA2CE71f5b5F6CDE066cff1Bc0461e2044;
    address constant ARC_HOOK_2 = 0xeAcc65fB1Bc692F1D208BAfb3AbFd397Ed72a044;
    address constant ARC_HOOK_3 = 0x605Be64d68d119ade7C8b3a97a568b8b18cA6044;
    address constant ARC_HOOK_4 = 0x46dE2a26726E2c3A9b72C9B3eD6e30a42D77a044;

    function test_realArcHooksAllMatchBaseline() public pure {
        address[4] memory hooks = [ARC_HOOK_1, ARC_HOOK_2, ARC_HOOK_3, ARC_HOOK_4];
        for (uint256 i; i < hooks.length; ++i) {
            assertEq(hooks[i].permissions(), HookPermissions.ARC_BASELINE);
            assertEq(hooks[i].beyondBaseline(HookPermissions.ARC_BASELINE), 0);
            assertFalse(hooks[i].canInterceptSwap());
        }
    }

    function test_baselineIsBeforeInitAndAfterSwapPair() public pure {
        assertTrue(ARC_HOOK_1.has(HookPermissions.BEFORE_INITIALIZE));
        assertTrue(ARC_HOOK_1.has(HookPermissions.AFTER_SWAP));
        assertTrue(ARC_HOOK_1.has(HookPermissions.AFTER_SWAP_RETURNS_DELTA));
        // The permissions that would let it block a sell are absent.
        assertFalse(ARC_HOOK_1.has(HookPermissions.BEFORE_SWAP));
        assertFalse(ARC_HOOK_1.has(HookPermissions.BEFORE_SWAP_RETURNS_DELTA));
    }

    /// The whole point: a normal hook must cost nothing, or 95% of Arc is flagged.
    function test_normalHookIsNotDangerous() public pure {
        assertFalse(ARC_HOOK_2.canInterceptSwap());
        assertTrue(ARC_HOOK_2.takesSwapFee()); // it does take a cut — that is fine
    }

    function test_beforeSwapIsFlagged() public pure {
        address hook = _withPermissions(
            HookPermissions.ARC_BASELINE | (uint16(1) << HookPermissions.BEFORE_SWAP)
        );
        assertTrue(hook.canInterceptSwap());
        assertTrue(hook.beyondBaseline(HookPermissions.ARC_BASELINE) != 0);
    }

    function test_beforeSwapReturnsDeltaIsFlagged() public pure {
        address hook = _withPermissions(
            HookPermissions.ARC_BASELINE | (uint16(1) << HookPermissions.BEFORE_SWAP_RETURNS_DELTA)
        );
        assertTrue(hook.canInterceptSwap());
    }

    /// Deviation that cannot touch a swap is surfaced but not called dangerous.
    function test_liquidityPermissionsDeviateButAreNotDangerous() public pure {
        address hook = _withPermissions(
            HookPermissions.ARC_BASELINE | (uint16(1) << HookPermissions.BEFORE_ADD_LIQUIDITY)
        );
        assertFalse(hook.canInterceptSwap());
        assertTrue(hook.beyondBaseline(HookPermissions.ARC_BASELINE) != 0);
    }

    function test_zeroHookDeclaresNothing() public pure {
        assertEq(address(0).permissions(), 0);
        assertFalse(address(0).canInterceptSwap());
        assertFalse(address(0).takesSwapFee());
    }

    function test_onlyLow14BitsAreRead() public pure {
        address hook = 0xFfffffffFFfFfFFFFfFffFFffFfFFfffFfff2044;
        assertEq(hook.permissions(), HookPermissions.ARC_BASELINE);
    }

    function testFuzz_permissionsNeverExceedMask(address hook) public pure {
        assertLe(uint256(hook.permissions()), 0x3fff);
    }

    function testFuzz_dangerousImpliesBeyondBaseline(address hook) public pure {
        // The baseline carries no swap-intercepting permission, so anything that
        // can intercept must by definition sit outside it.
        if (hook.canInterceptSwap()) {
            assertTrue(hook.beyondBaseline(HookPermissions.ARC_BASELINE) != 0);
        }
    }

    function _withPermissions(uint16 perms) internal pure returns (address) {
        return address(uint160(0xAAAA << 144) | uint160(perms));
    }
}
