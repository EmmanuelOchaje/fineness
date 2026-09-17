// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {
    IPoolManager,
    IUnlockCallback,
    IERC20Minimal,
    PoolKey,
    SwapParams,
    Currency,
    BalanceDelta,
    BalanceDeltaLib,
    TickMath
} from "./interfaces/IPoolManager.sol";

/**
 * Executes a real USDC -> token -> USDC round trip against a Uniswap v4 pool.
 *
 * ## Why this is not a view function
 *
 * It is called through `eth_call`, which executes state-changing code against
 * simulated state and throws the result away. Nothing persists, no gas is paid,
 * no real trade happens. The contract is funded by a `balance` state override in
 * the call itself — and because Arc's native balance and its USDC ERC-20 balance
 * are the same balance, overriding native balance is enough to make
 * `USDC.balanceOf(simulator)` return funds. Verified on mainnet.
 *
 * So this contract never needs to hold real money, and holds no keys.
 *
 * ## Why every step emits an event
 *
 * Arc serves no tracing RPCs — `debug_traceCall` and `trace_call` both return
 * -32014. Events are the ONLY debugging surface for this contract. Do not
 * remove them to save gas; gas is free here.
 *
 * ## How tax attribution works
 *
 * `settle()` credits what PoolManager ACTUALLY received, and `take()` sends an
 * amount the pool computed. Comparing each against our own balance change
 * separates two very different things:
 *
 *   - the TOKEN's transfer tax (the gap between sent and credited)
 *   - the POOL and HOOK's fees (the rest of the round-trip loss)
 *
 * On Arc that distinction matters more than usual: ~95% of pools run a hook that
 * takes a cut of every swap, so some loss is normal launchpad behaviour rather
 * than anything the token is doing. Reporting one blended "tax" number would
 * misattribute a 1% launchpad fee as token malice.
 */
contract Simulator is IUnlockCallback {
    using BalanceDeltaLib for BalanceDelta;

    IPoolManager public immutable poolManager;
    address public immutable usdc;

    struct SimResult {
        // --- buy leg ---
        uint256 usdcSent;
        uint256 usdcCredited; // what PoolManager actually received
        uint256 tokensFromPool; // what the pool said we get
        uint256 tokensReceived; // what actually landed in our balance
        bool buySucceeded;
        // --- sell leg ---
        uint256 tokensSent;
        uint256 tokensCredited;
        uint256 usdcFromPool;
        uint256 usdcReceived;
        bool sellSucceeded;
        // --- diagnosis ---
        string failureReason;
    }

    event BuyLeg(uint256 usdcSent, uint256 usdcCredited, uint256 fromPool, uint256 received);
    event SellLeg(uint256 tokensSent, uint256 tokensCredited, uint256 fromPool, uint256 received);
    event SellFailed(string reason);
    event Unlocked(address token, bool zeroForOne);

    error NotPoolManager();
    error PoolHasNoUsdc();
    error BuyLegFailed(string reason);
    error NothingReceived();

    constructor(IPoolManager _poolManager, address _usdc) {
        poolManager = _poolManager;
        usdc = _usdc;
    }

    /**
     * @param key   The pool to trade against. USDC must be one of its currencies.
     * @param usdcAmount Amount of USDC (6 decimals) to round-trip.
     *
     * @dev USDC is NOT reliably `currency0` on Arc — it is currency0 in ~75% of
     *      pools and currency1 in ~19%, because v4 sorts currencies by address
     *      and 0x3600... sorts mid-range. Direction is therefore derived from
     *      the key at runtime. Hard-coding it swaps backwards on a fifth of the
     *      chain and returns a plausible number that is wrong, with no error.
     */
    function simulate(PoolKey calldata key, uint256 usdcAmount)
        external
        returns (SimResult memory result)
    {
        bytes memory out = poolManager.unlock(abi.encode(key, usdcAmount));
        result = abi.decode(out, (SimResult));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();

        (PoolKey memory key, uint256 usdcAmount) = abi.decode(data, (PoolKey, uint256));

        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);

        // 5% of Arc pools are token/token and contain no USDC at all. Reject
        // them explicitly rather than inventing a multi-hop route.
        if (c0 != usdc && c1 != usdc) revert PoolHasNoUsdc();

        bool usdcIsZero = (c0 == usdc);
        address token = usdcIsZero ? c1 : c0;

        emit Unlocked(token, usdcIsZero);

        SimResult memory r;

        // ---- BUY: USDC -> token -------------------------------------------
        // Failure here is not a honeypot finding, it is an unusable pool, so it
        // reverts rather than returning a misleading clean negative.
        (r.usdcSent, r.usdcCredited, r.tokensFromPool, r.tokensReceived) =
            _swapLeg(key, usdc, token, usdcAmount, usdcIsZero);
        r.buySucceeded = true;
        emit BuyLeg(r.usdcSent, r.usdcCredited, r.tokensFromPool, r.tokensReceived);

        if (r.tokensReceived == 0) revert NothingReceived();

        // ---- SELL: token -> USDC ------------------------------------------
        // Wrapped in an external self-call so a blocked sell produces a clean
        // negative result instead of reverting the whole simulation. That is the
        // entire point: a honeypot must return `sellSucceeded = false`, not a
        // failed eth_call that the caller cannot distinguish from a network
        // error.
        //
        // The revert also rolls back this leg's PoolManager deltas. Because the
        // buy leg settled to zero, the lock can still close cleanly.
        try this.sellLeg(key, token, r.tokensReceived, !usdcIsZero) returns (
            uint256 sent, uint256 credited, uint256 fromPool, uint256 received
        ) {
            r.tokensSent = sent;
            r.tokensCredited = credited;
            r.usdcFromPool = fromPool;
            r.usdcReceived = received;
            r.sellSucceeded = true;
            emit SellLeg(sent, credited, fromPool, received);
        } catch Error(string memory reason) {
            r.sellSucceeded = false;
            r.failureReason = reason;
            emit SellFailed(reason);
        } catch (bytes memory lowLevel) {
            r.sellSucceeded = false;
            r.failureReason = _decodePanic(lowLevel);
            emit SellFailed(r.failureReason);
        }

        return abi.encode(r);
    }

    /// @dev External only so the caller can try/catch it. Rejects outside calls.
    function sellLeg(PoolKey memory key, address token, uint256 amount, bool tokenIsZero)
        external
        returns (uint256 sent, uint256 credited, uint256 fromPool, uint256 received)
    {
        if (msg.sender != address(this)) revert NotPoolManager();
        return _swapLeg(key, token, usdc, amount, tokenIsZero);
    }

    /**
     * One leg of the round trip.
     *
     * v4 settlement order: sync the currency, transfer it in, then settle() —
     * which credits what ACTUALLY arrived. For a fee-on-transfer token that is
     * less than what was sent, and the gap is the transfer tax, measured rather
     * than guessed.
     */
    function _swapLeg(
        PoolKey memory key,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        bool inputIsZero
    ) internal returns (uint256 sent, uint256 credited, uint256 fromPool, uint256 received) {
        sent = amountIn;

        poolManager.sync(inputIsZero ? key.currency0 : key.currency1);

        // Check the return value. A token that returns FALSE instead of
        // reverting is a real and common honeypot shape — ignoring the bool
        // would let such a token sail through the sell leg with `credited == 0`
        // and be scored as clean. Treat it exactly like a revert.
        (bool ok, bytes memory ret) = tokenIn.call(
            abi.encodeWithSelector(IERC20Minimal.transfer.selector, address(poolManager), amountIn)
        );
        require(ok, "transfer reverted");
        require(ret.length == 0 || abi.decode(ret, (bool)), "transfer returned false");

        credited = poolManager.settle();

        // Swap exactly what the pool actually received. Using `amountIn` here
        // instead would over-specify for a fee-on-transfer token and revert
        // deep inside PoolManager with an opaque error.
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: inputIsZero,
                amountSpecified: -int256(credited),
                sqrtPriceLimitX96: inputIsZero
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        int128 outDelta = inputIsZero ? delta.amount1() : delta.amount0();
        // A non-positive output means the hook or pool gave us nothing back.
        require(outDelta > 0, "no output");
        fromPool = uint256(uint128(outDelta));

        uint256 before = IERC20Minimal(tokenOut).balanceOf(address(this));
        poolManager.take(inputIsZero ? key.currency1 : key.currency0, address(this), fromPool);
        received = IERC20Minimal(tokenOut).balanceOf(address(this)) - before;
    }

    function _decodePanic(bytes memory data) internal pure returns (string memory) {
        if (data.length == 0) return "silent revert";
        // Custom error selector — report it so the caller can look it up.
        if (data.length >= 4) {
            bytes4 sel;
            assembly {
                sel := mload(add(data, 0x20))
            }
            if (sel == 0x4e487b71) return "panic";
            return string.concat("custom error 0x", _toHex(sel));
        }
        return "unknown revert";
    }

    function _toHex(bytes4 b) internal pure returns (string memory) {
        bytes memory hexChars = "0123456789abcdef";
        bytes memory out = new bytes(8);
        for (uint256 i = 0; i < 4; i++) {
            out[i * 2] = hexChars[uint8(b[i]) >> 4];
            out[i * 2 + 1] = hexChars[uint8(b[i]) & 0x0f];
        }
        return string(out);
    }
}
