// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {XSwapIntents} from "../src/xswap/XSwapIntents.sol";
import {XSwapAsks} from "../src/xswap/XSwapAsks.sol";

interface ISafeLike {
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
}

/**
 * @notice Redeploy of XSwapIntents + XSwapAsks on Robinhood Chain (#4663), with an owner someone can actually sign for.
 *
 *  Why this exists. The first deployment (nft-range script/DeployXSwap.s.sol, 2026-09-22; intents 0xf8B4…9a35,
 *  asks 0x0a33…Cd13, and an earlier intents 0x3d44…8301) did
 *      address owner = vm.envOr("PROTOCOL_OWNER", msg.sender);
 *      vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
 *  PROTOCOL_OWNER was unset and no --sender was passed, so msg.sender in run(), which is read BEFORE startBroadcast,
 *  was forge-std's DEFAULT_SENDER 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38 (keccak256("foundry default caller")).
 *  The broadcast key (0x26E8…5158) paid for the deploys, but both constructors got DEFAULT_SENDER as owner_. Nobody
 *  holds a key for that address, so resolve(), setParams(), transferOwnership() and renounceOwnership() can never be
 *  called on those contracts: a dispute there is frozen forever, escrow and bond both.
 *
 *  What this script does differently:
 *    - OWNER is required. There is no default and msg.sender is never read.
 *    - OWNER may not be address(0) or DEFAULT_SENDER.
 *    - OWNER must be one of: the broadcasting key itself (proves someone holds it), a Safe (answers getThreshold()
 *      and getOwners()), or another EOA typed twice (OWNER_CONFIRM == OWNER), as a typo guard.
 *    - The deployer is always vm.addr(PRIVATE_KEY); deploy() takes no deployer argument that could claim otherwise.
 *    - owner() on both contracts is read back after deployment and must equal OWNER, with no pending owner.
 *    - It deploys src/xswap/, which differs from v1 in two ways: deposits book the xMoney that arrived, not the
 *      amount sent (xMoney burns 1 bp per transfer, so v1 owed more than it held; test/XSwap.fork.t.sol pins both),
 *      and ownership is Ownable2Step with renounceOwnership() disabled, so a later handover to a mistyped address,
 *      or to a Safe that only exists on another chain, never takes effect: the new owner has to accept it by signing.
 *
 *  Moving to a Safe later: the owner calls transferOwnership(safe) on both contracts, then the Safe calls
 *  acceptOwnership() on both. Check with owner() and pendingOwner().
 *
 *  Recommended OWNER: a Safe if there is one for this (set OWNER to it), otherwise the founder wallet
 *  0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158, broadcasting from that same key.
 *
 *  Dry run first (no --broadcast: simulates against the chain, sends nothing):
 *    OWNER=0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158 PRIVATE_KEY=... \
 *      forge script script/DeployXSwap.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com
 *  Then the same command with --broadcast.
 *
 *  Optional: TREASURY (default the 8010 Wizards fanout, as before), XMONEY (default the Robinhood xMoney),
 *  OWNER_CONFIRM (only for an EOA owner that is not the broadcaster).
 *
 *  Afterwards record the printed block as "xswap" in src/contracts/l4-deployment.json. The MCP reads
 *  xswap.intents / xswap.asks / xswap.owner from there, and XSwap writes stay off until XSWAP_ENABLED=1 (env) or
 *  "enabled": true in that block. Without xswap.owner (or XSWAP_OWNER) they stay off regardless: every new swap
 *  checks owner() on both contracts against it.
 */
contract DeployXSwap is Script {
    uint256 constant ROBINHOOD_CHAIN_ID = 4663;
    address constant XMONEY = 0xa924C725B64cC346f275269EFA4Bd0538cfBa97E;
    address constant FANOUT_8010 = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;
    /// forge-std Base.sol DEFAULT_SENDER: address(uint160(uint256(keccak256("foundry default caller")))). No key exists.
    address constant FORGE_DEFAULT_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;
    address constant FOUNDER = 0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158;

    function run() external returns (XSwapIntents intents, XSwapAsks asks) {
        require(block.chainid == ROBINHOOD_CHAIN_ID, "not Robinhood Chain 4663");
        uint256 pk = _privateKey();
        address owner = vm.envAddress("OWNER"); // required: reverts when unset
        address xmoney = vm.envOr("XMONEY", XMONEY);
        address treasury = vm.envOr("TREASURY", FANOUT_8010);
        address ownerConfirm = vm.envOr("OWNER_CONFIRM", address(0));

        return deploy(pk, owner, xmoney, treasury, ownerConfirm);
    }

    /// Everything after the env reads, callable from a test with explicit arguments. The deployer is always derived
    /// from `pk`, never passed in: checkOwner's "the owner is the broadcasting key" branch skips the OWNER_CONFIRM
    /// typo guard, so a caller-supplied deployer equal to any OWNER would bypass it.
    function deploy(uint256 pk, address owner, address xmoney, address treasury, address ownerConfirm)
        public
        returns (XSwapIntents intents, XSwapAsks asks)
    {
        address deployer = vm.addr(pk);
        checkOwner(owner, deployer, ownerConfirm);
        require(xmoney.code.length > 0, "XMONEY has no code");
        require(treasury != address(0), "TREASURY is zero");

        console.log("=== DEPLOYING XSWAP (intents + asks) ===");
        console.log("Chain ID:   ", block.chainid);
        console.log("Deployer:   ", deployer);
        console.log("Owner:      ", owner);
        console.log("xMoney:     ", xmoney);
        console.log("Treasury:   ", treasury);

        vm.startBroadcast(pk);
        intents = new XSwapIntents(IERC20(xmoney), owner, treasury);
        asks = new XSwapAsks(IERC20(xmoney), owner, treasury);
        vm.stopBroadcast();

        require(intents.owner() == owner, "intents owner() mismatch");
        require(asks.owner() == owner, "asks owner() mismatch");
        require(intents.pendingOwner() == address(0) && asks.pendingOwner() == address(0), "pendingOwner set at deploy");
        require(address(intents.xmoney()) == xmoney && address(asks.xmoney()) == xmoney, "xmoney wiring");
        require(intents.treasury() == treasury && asks.treasury() == treasury, "treasury wiring");

        console.log("XSwapIntents:", address(intents));
        console.log("XSwapAsks:   ", address(asks));
        console.log("Record in src/contracts/l4-deployment.json:");
        console.log(
            string.concat(
                '  "xswap": { "intents": "',
                vm.toString(address(intents)),
                '", "asks": "',
                vm.toString(address(asks)),
                '", "owner": "',
                vm.toString(owner),
                '", "treasury": "',
                vm.toString(treasury),
                '", "chainId": 4663, "enabled": false }'
            )
        );
        console.log("Flip enabled to true (or set XSWAP_ENABLED=1 on the MCP host) once the addresses are checked.");
        console.log("Handing over later (to a Safe, say) is two steps: the owner calls transferOwnership(new), then the new");
        console.log("owner calls acceptOwnership(). Until it accepts, the old owner still rules. renounceOwnership() reverts.");
    }

    /// Reverts unless `owner` is an address somebody can sign for.
    function checkOwner(address owner, address deployer, address ownerConfirm) public view {
        require(owner != address(0), "OWNER is address(0)");
        require(owner != FORGE_DEFAULT_SENDER, "OWNER is forge-std DEFAULT_SENDER: nobody holds that key");
        if (owner.code.length > 0 && !isDelegatedEoa(owner)) {
            // A contract owner must be a Safe with at least one signer, never an arbitrary contract. Low-level calls,
            // so a contract without these functions fails with this message instead of an ABI decoding error.
            (bool ok, bytes memory ret) = owner.staticcall(abi.encodeWithSelector(ISafeLike.getThreshold.selector));
            require(ok && ret.length >= 32, "OWNER is a contract but not a Safe");
            uint256 threshold = abi.decode(ret, (uint256));
            (ok, ret) = owner.staticcall(abi.encodeWithSelector(ISafeLike.getOwners.selector));
            require(ok && ret.length >= 64, "OWNER is a contract but not a Safe");
            address[] memory signers = abi.decode(ret, (address[]));
            require(threshold > 0 && signers.length >= threshold, "OWNER is a contract but not a working Safe");
            console.log("Owner is a Safe. Threshold:", threshold);
            console.log("Safe signers:", signers.length);
        } else if (owner != deployer) {
            // an EOA, possibly EIP-7702 delegated (a key still signs for it): typo guard
            require(ownerConfirm == owner, "OWNER is an EOA other than the broadcaster: set OWNER_CONFIRM to the same address");
        }
        if (isDelegatedEoa(owner)) console.log("Owner is an EIP-7702 delegated EOA: its key signs, its delegate code runs.");
        if (owner == FOUNDER) console.log("Owner is the founder wallet.");
    }

    /// EIP-7702: an EOA with a delegation carries exactly 0xef0100 ++ <20-byte delegate> as code.
    function isDelegatedEoa(address a) public view returns (bool) {
        bytes memory c = a.code;
        return c.length == 23 && c[0] == 0xef && c[1] == 0x01 && c[2] == 0x00;
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
