// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * Uniswap v4 hook permission decoding — the product's differentiating check.
 *
 * v4 encodes a hook's permissions in the LOW 14 BITS OF ITS OWN ADDRESS. A hook
 * can only be deployed at an address whose low bits match the callbacks it
 * implements, which is why v4 hook addresses look mined. That makes permissions
 * tamper-proof and readable without a single external call.
 *
 * Why this replaces the usual "is the LP burned" check:
 *
 *   On Arc, 95% of pools carry a hook, and a survey of 4,156 live pools found
 *   3,823 DISTINCT hook addresses across 3,965 hooked pools — a fresh hook per
 *   pool. So hook *presence* flags essentially the whole chain and proves
 *   nothing, and an address allowlist is impossible because addresses are never
 *   reused. The permissions are where the signal is.
 *
 * Mirrors shared/src/hooks.ts. Both are unit-tested against the same real
 * mainnet addresses; if you change one, change the other.
 */
library HookPermissions {
    uint160 internal constant MASK = 0x3fff;

    // Bit positions within the low 14 bits.
    uint8 internal constant AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA = 0;
    uint8 internal constant AFTER_ADD_LIQUIDITY_RETURNS_DELTA = 1;
    uint8 internal constant AFTER_SWAP_RETURNS_DELTA = 2;
    uint8 internal constant BEFORE_SWAP_RETURNS_DELTA = 3;
    uint8 internal constant AFTER_DONATE = 4;
    uint8 internal constant BEFORE_DONATE = 5;
    uint8 internal constant AFTER_SWAP = 6;
    uint8 internal constant BEFORE_SWAP = 7;
    uint8 internal constant AFTER_REMOVE_LIQUIDITY = 8;
    uint8 internal constant BEFORE_REMOVE_LIQUIDITY = 9;
    uint8 internal constant AFTER_ADD_LIQUIDITY = 10;
    uint8 internal constant BEFORE_ADD_LIQUIDITY = 11;
    uint8 internal constant AFTER_INITIALIZE = 12;
    uint8 internal constant BEFORE_INITIALIZE = 13;

    /**
     * The Arc ecosystem baseline, measured across 4,156 pools on 2026-09-17:
     *
     *   0x2044 = BEFORE_INITIALIZE | AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA
     *
     * A hook taking a cut of every swap — the standard launchpad pattern,
     * consistent with aka.fun's documented trading fee. This is NORMAL and must
     * not cost score, or 95% of the chain gets flagged and the mark means
     * nothing.
     *
     * WARNING: empirical, not canonical. Four days into a chain's life. A second
     * launchpad with different permissions would need this re-measured, which is
     * why Fineness stores it as mutable config rather than hard-coding it.
     */
    uint16 internal constant ARC_BASELINE = 0x2044;

    /**
     * Permissions that let a hook intercept a swap BEFORE it executes — i.e.
     * block a sell outright or re-price it arbitrarily. The Arc baseline does
     * not carry these. A hook that does is the strongest deterministic honeypot
     * signal available on v4.
     */
    uint16 internal constant DANGEROUS_MASK = (uint16(1) << BEFORE_SWAP)
        | (uint16(1) << BEFORE_SWAP_RETURNS_DELTA);

    function permissions(address hook) internal pure returns (uint16) {
        if (hook == address(0)) return 0;
        return uint16(uint160(hook) & MASK);
    }

    function has(address hook, uint8 flag) internal pure returns (bool) {
        return (permissions(hook) >> flag) & 1 == 1;
    }

    /// @return Permissions held beyond the supplied baseline.
    function beyondBaseline(address hook, uint16 baseline) internal pure returns (uint16) {
        return permissions(hook) & ~baseline;
    }

    /// @notice Can this hook block or re-price a sell?
    function canInterceptSwap(address hook) internal pure returns (bool) {
        return permissions(hook) & DANGEROUS_MASK != 0;
    }

    /// @notice Does this hook take a cut of each swap? True for the Arc norm —
    ///         informational, not a fault.
    function takesSwapFee(address hook) internal pure returns (bool) {
        return has(hook, AFTER_SWAP_RETURNS_DELTA) || has(hook, BEFORE_SWAP_RETURNS_DELTA);
    }
}
