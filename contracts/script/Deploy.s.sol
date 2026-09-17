// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Simulator} from "../src/Simulator.sol";
import {Fineness} from "../src/Fineness.sol";
import {IPoolManager} from "../src/interfaces/IPoolManager.sol";

/**
 * Deploy Fineness and Simulator to Arc mainnet (chain 5042).
 *
 *   forge script script/Deploy.s.sol --rpc-url $ARC_RPC_URL --broadcast
 *
 * Gas is paid in USDC, not ETH. The deployer wallet needs Arc USDC or nothing
 * will send.
 */
contract Deploy is Script {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant USDC = 0x3600000000000000000000000000000000000000;
    uint256 constant MIN_BASE_FEE = 20 gwei;
    bytes32 constant SALT = keccak256("fineness.simulator.v1");

    function run() external {
        _preflight();

        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        console.log("deployer     ", deployer);
        console.log("balance (wei)", deployer.balance);

        require(deployer.balance > 0, "Deployer holds no USDC. Gas is USDC on Arc - fund it first.");

        // Simulator goes out via CREATE2 at a deterministic address, because
        // Fineness references it as a `constant` (see Simulator.sol for why the
        // chain addresses are constants rather than immutables). Salt is fixed;
        // the address is computable before deployment and baked into Fineness.
        vm.startBroadcast(pk);
        Simulator simulator = new Simulator{salt: SALT}();
        Fineness fineness = new Fineness();
        require(
            address(fineness.simulator()) == address(simulator),
            "CREATE2 mismatch - Simulator bytecode changed; recompute and update the constant in Fineness.sol"
        );
        vm.stopBroadcast();

        console.log("");
        console.log("Simulator    ", address(simulator));
        console.log("Fineness     ", address(fineness));
        console.log("");
        console.log("Verification: explorer.arc.io is permissioned, so public source");
        console.log("verification may be unavailable. Commit build artifacts and the");
        console.log("compiler settings so a reviewer can reproduce the bytecode.");
    }

    /**
     * Arc's minimum base fee is 20 gwei, and transactions below it are dropped
     * by the mempool with NO error and NO receipt. A deploy that silently
     * vanishes is far worse than one that refuses to start, so assert loudly
     * before broadcasting anything.
     */
    function _preflight() internal view {
        require(block.chainid == 5042, "Wrong chain - expected Arc mainnet (5042)");

        uint256 fee = block.basefee;
        console.log("chain id     ", block.chainid);
        console.log("base fee     ", fee);

        require(
            fee == 0 || fee >= MIN_BASE_FEE,
            "Base fee below Arc's 20 gwei floor - transactions would be silently dropped"
        );

        // Guard against the squatted-address trap: several canonical Uniswap
        // addresses hold unrelated bytecode on Arc, so presence of code proves
        // nothing. Assert the PoolManager answers a method it actually has.
        require(POOL_MANAGER.code.length > 0, "PoolManager has no code");
        (bool ok, bytes memory ret) =
            POOL_MANAGER.staticcall(abi.encodeWithSignature("owner()"));
        require(ok && ret.length == 32, "PoolManager did not answer owner() - wrong address?");
        require(abi.decode(ret, (address)) != address(0), "PoolManager owner is zero - suspicious");

        require(USDC.code.length > 0, "USDC has no code");
    }
}
