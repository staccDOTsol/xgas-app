// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PlasmaChild} from "../src/PlasmaChild.sol";
import {L1GatewayRouter} from "token-bridge/tokenbridge/ethereum/gateway/L1GatewayRouter.sol";
import {L1ERC20Gateway} from "token-bridge/tokenbridge/ethereum/gateway/L1ERC20Gateway.sol";
import {IInbox} from "nitro-src/bridge/IInbox.sol";

/// @notice Bridge the deployer's 1000.428045 USDT0 from Plasma into the child.
///         The L2 token is credited to L2_RECIPIENT (the deployer) when the
///         sequencer includes the retryable. The child vault deposit happens
///         after that token exists; this transaction is the parent-chain leg.
contract SeedPlasmaUsdt0 is Script {
    address internal deployer;
    address internal router;
    address internal gateway;
    address internal inbox;
    address internal recipient;
    uint256 internal amount;
    uint256 internal maxGas;
    uint256 internal gasPriceBid;
    uint256 internal fee;
    uint256 internal callValue;
    uint256 internal sequence;

    function run() external {
        deployer = vm.envAddress("DEPLOYER");
        require(block.chainid == PlasmaChild.PARENT_CHAIN_ID, "not plasma");
        router = vm.envAddress("ROUTER");
        gateway = vm.envAddress("GATEWAY");
        inbox = vm.envAddress("INBOX");
        recipient = vm.envOr("L2_RECIPIENT", deployer);
        amount = vm.envOr("SEED_AMOUNT", PlasmaChild.SEED_USDT0);
        maxGas = vm.envOr("L2_MAX_GAS", uint256(1_000_000));
        gasPriceBid = vm.envOr("L2_GAS_PRICE_BID", uint256(100_000_000));
        _quote();
        _broadcast();
        _write();
    }

    function _quote() internal {
        IERC20 token = IERC20(PlasmaChild.USDT0);
        require(token.balanceOf(deployer) >= amount, "deployer USDT0 below 1000.428045");
        bytes memory outbound =
            L1ERC20Gateway(gateway).getOutboundCalldata(address(token), deployer, recipient, amount, "");
        // Double the current basefee quote so a one-block bump still covers submission.
        fee = IInbox(inbox).calculateRetryableSubmissionFee(outbound.length, block.basefee) * 2;
        if (fee == 0) fee = 1;
        // 0.1 gwei on the child, 1_000_000 gas. Enough for the gateway to mint
        // the L2 token once the sequencer is up. Excess is refundable there.
        callValue = fee + maxGas * gasPriceBid;
        require(deployer.balance >= callValue, "not enough XPL for the retryable");
    }

    function _broadcast() internal {
        IERC20 token = IERC20(PlasmaChild.USDT0);
        uint256 escrowBefore = token.balanceOf(gateway);
        bytes memory userData = abi.encode(fee, bytes(""));

        vm.startBroadcast(deployer);
        // Allowance is spent by the gateway (transferFrom the depositor), not the router.
        // A raw approve: SafeERC20 reads allowance(address(this)), which a script forbids.
        require(token.approve(gateway, amount), "usdt0 approve failed");
        bytes memory seq = L1GatewayRouter(router).outboundTransfer{value: callValue}(
            address(token), recipient, amount, maxGas, gasPriceBid, userData
        );
        vm.stopBroadcast();

        require(token.balanceOf(gateway) - escrowBefore == amount, "gateway did not escrow the full seed");
        sequence = abi.decode(seq, (uint256));
    }

    function _write() internal {
        console.log("seed usdt0", amount);
        console.log("l2 recipient", recipient);
        console.log("retryable value wei", callValue);
        console.log("gateway", gateway);
        console.log("router", router);
        console.log("inbox sequence", sequence);

        string memory obj = "seed";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "deployer", deployer);
        vm.serializeAddress(obj, "l2Recipient", recipient);
        vm.serializeAddress(obj, "token", PlasmaChild.USDT0);
        vm.serializeUint(obj, "amount", amount);
        vm.serializeAddress(obj, "gateway", gateway);
        vm.serializeAddress(obj, "router", router);
        vm.serializeAddress(obj, "inbox", inbox);
        vm.serializeUint(obj, "retryableValueWei", callValue);
        vm.serializeUint(obj, "maxGas", maxGas);
        vm.serializeUint(obj, "gasPriceBid", gasPriceBid);
        vm.serializeUint(obj, "submissionFee", fee);
        string memory json = vm.serializeUint(obj, "inboxSequence", sequence);
        vm.writeJson(json, "deployments/plasma-seed.json");
    }
}
