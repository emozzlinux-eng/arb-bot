// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {FlashLoanArb} from "../src/FlashLoanArb.sol";

/// @notice Env-driven deployer — same script works on Polygon/Ethereum/Base.
/// Required env: RPC_URL PRIVATE_KEY AAVE_POOL COLD_WALLET PROFIT_TOKEN
///               BORROW_TOKEN MIN_PROFIT_WEI POOL_A POOL_B POOL_A_ZFO POOL_B_ZFO
contract DeployScript is Script {
    function run() external returns (FlashLoanArb arb) {
        uint256 pk       = vm.envUint("PRIVATE_KEY");
        address aave     = vm.envAddress("AAVE_POOL");
        address cold     = vm.envAddress("COLD_WALLET");
        address usdc     = vm.envAddress("PROFIT_TOKEN");
        address borrow   = vm.envAddress("BORROW_TOKEN");
        uint256 minProf  = vm.envUint("MIN_PROFIT_WEI");

        vm.startBroadcast(pk);
        arb = new FlashLoanArb(aave, cold, usdc, borrow, minProf);
        arb.setRoute(
            vm.envAddress("POOL_A"),
            vm.envAddress("POOL_B"),
            vm.envBool("POOL_A_ZFO"),
            vm.envBool("POOL_B_ZFO")
        );
        vm.stopBroadcast();

        console2.log("FlashLoanArb deployed at:", address(arb));
    }
}
