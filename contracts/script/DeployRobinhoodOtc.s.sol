// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {RobinhoodEthOtc} from "../src/RobinhoodEthOtc.sol";
import {IOtcArbitration} from "../src/interfaces/IOtcArbitration.sol";

/**
 * @notice Robinhood Chain (#4663) deployment of the X Money dollars <-> ETH OTC desk.
 *         1. OtcArbitration (the deployer is the only account allowed to bind it, once)
 *         2. RobinhoodEthOtc(WETH, Fee Fanout, arbitration): the whole 0.1% fee goes to the Fee Fanout as WETH
 *         3. arbitration.bind(escrow), after which neither contract has an admin.
 *
 *   PRIVATE_KEY=... forge script script/DeployRobinhoodOtc.s.sol \
 *     --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast
 *
 *   Then record the addresses as l3.otcArbitration / l3.robinhoodOtc in src/contracts/l4-deployment.json
 *   and as OTC_ARBITRATION / ROBINHOOD_OTC in src/contracts/abis.ts. Arbiters who want to vote on the first
 *   disputes must stake at least STAKE_AGE (3 days) before those disputes open.
 */
contract DeployRobinhoodOtc is Script {
    uint256 constant ROBINHOOD_CHAIN_ID = 4663;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant FEE_FANOUT = 0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e;

    function run() external returns (address arbitration, address escrow) {
        require(block.chainid == ROBINHOOD_CHAIN_ID, "not Robinhood Chain 4663");
        require(WETH.code.length > 0, "WETH missing");
        require(FEE_FANOUT.code.length > 0, "Fee Fanout missing");

        uint256 pk = _privateKey();
        address deployer = vm.addr(pk);
        console.log("=== DEPLOYING ROBINHOOD ETH OTC ===");
        console.log("Deployer:", deployer);
        console.log("Chain ID:", block.chainid);

        vm.startBroadcast(pk);
        // by artifact name so this script does not pin OtcArbitration's source at compile time
        arbitration = vm.deployCode("OtcArbitration.sol:OtcArbitration");
        escrow = address(new RobinhoodEthOtc(WETH, FEE_FANOUT, arbitration));
        IOtcArbitration(arbitration).bind(escrow);
        vm.stopBroadcast();

        require(IOtcArbitration(arbitration).escrow() == escrow, "bind failed");
        require(RobinhoodEthOtc(escrow).arbitration() == arbitration, "escrow wiring");
        require(RobinhoodEthOtc(escrow).weth() == WETH, "escrow weth");
        require(RobinhoodEthOtc(escrow).feeFanout() == FEE_FANOUT, "escrow fanout");

        console.log("OtcArbitration  (l3.otcArbitration / OTC_ARBITRATION):", arbitration);
        console.log("RobinhoodEthOtc (l3.robinhoodOtc   / ROBINHOOD_OTC):  ", escrow);
    }

    function _privateKey() internal view returns (uint256) {
        try vm.envUint("PRIVATE_KEY") returns (uint256 k) {
            return k;
        } catch {
            string memory raw = vm.envString("PRIVATE_KEY");
            if (bytes(raw).length == 64) return vm.parseUint(string.concat("0x", raw));
            return vm.parseUint(raw);
        }
    }
}
