// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * Minimal Uniswap v4 surface, vendored rather than importing v4-core.
 *
 * Rationale: the Simulator needs six methods and three types. Pulling v4-core
 * and v4-periphery drags in hundreds of files, pins solc, and buries the part a
 * reviewer actually needs to read. These declarations mirror v4-core exactly —
 * if they drift, the ABI encoding breaks loudly at the first fork test, not
 * silently.
 *
 * Verified against the live PoolManager on Arc at
 * 0x8366a39CC670B4001A1121B8F6A443A643e40951.
 */

type Currency is address;

/// @dev In v4, address(0) denotes the chain's native asset.
///      On Arc this convention is NOT used for USDC — pools reference the
///      ERC-20 address 0x3600...0000 instead, despite USDC being native.
///      Confirmed across 130,462 live pools. See ARC-FINDINGS.md.
struct PoolKey {
    Currency currency0;
    Currency currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    /// @dev Negative = exact input, positive = exact output.
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

/// @dev Packed: amount0 in the upper 128 bits, amount1 in the lower 128.
type BalanceDelta is int256;

library BalanceDeltaLib {
    function amount0(BalanceDelta d) internal pure returns (int128) {
        return int128(BalanceDelta.unwrap(d) >> 128);
    }

    function amount1(BalanceDelta d) internal pure returns (int128) {
        return int128(int256(BalanceDelta.unwrap(d)));
    }
}

interface IPoolManager {
    /// @notice Opens the lock. PoolManager calls back into `unlockCallback`.
    function unlock(bytes calldata data) external returns (bytes memory);

    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (BalanceDelta);

    /// @notice Snapshot a currency's balance before transferring in.
    function sync(Currency currency) external;

    /// @notice Credit whatever arrived since `sync`. Returns the amount credited.
    /// @dev For a fee-on-transfer token this is LESS than the amount sent — that
    ///      difference is precisely the token's transfer tax.
    function settle() external payable returns (uint256 paid);

    function take(Currency currency, address to, uint256 amount) external;
}

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function totalSupply() external view returns (uint256);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

library TickMath {
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE =
        1461446703485210103287273052203988822378723970342;
}
