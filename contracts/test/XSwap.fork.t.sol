// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {XSwapIntents} from "../src/xswap/XSwapIntents.sol";
import {XSwapAsks} from "../src/xswap/XSwapAsks.sol";
import {DeployXSwap} from "../script/DeployXSwap.s.sol";

/// A contract that answers like a Safe, for the owner check.
contract FakeSafe {
    address[] internal signers;

    constructor(address s) {
        signers.push(s);
    }

    function getThreshold() external pure returns (uint256) {
        return 1;
    }

    function getOwners() external view returns (address[] memory) {
        return signers;
    }
}

/// Robinhood Chain (4663) fork: the real xMoney ERC-20, both XSwap contracts deployed through
/// script/DeployXSwap.s.sol exactly as the redeploy would, and every dispute path ruled on by the owner and refused
/// to everyone else. Also pins the reason for the redeploy: the live v1 contracts' owner() is forge-std's
/// DEFAULT_SENDER. FORK_URL defaults to the public RPC and FORK_BLOCK to the L2 head minus 50.
/// SKIP_FORK=true skips offline. Nothing here broadcasts: it all runs inside the local fork.
contract XSwapForkTest is Test {
    address constant XMONEY = 0xa924C725B64cC346f275269EFA4Bd0538cfBa97E;
    address constant FANOUT_8010 = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;
    address constant FORGE_DEFAULT_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;
    address constant FOUNDER = 0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158;
    address constant LIVE_INTENTS = 0xf8B4F14eF9A08e334CA9fc026C6e5E9a79B39a35;
    address constant LIVE_ASKS = 0x0a33001A28A82d50ECC5c166dd5DCb8f5efaCd13;
    address constant LIVE_INTENTS_FIRST = 0x3d4428cB247792e9183332c95A6A3C37b89E8301;
    string constant DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";

    DeployXSwap script;
    XSwapIntents x;
    XSwapAsks a;
    IERC20 xm = IERC20(XMONEY);

    uint256 deployerPk = uint256(keccak256("xswap fork deployer"));
    address deployer;
    address user = makeAddr("xswapUser");
    address solver = makeAddr("xswapSolver");
    address seller = makeAddr("xswapSeller");
    address buyer = makeAddr("xswapBuyer");
    address stranger = makeAddr("xswapStranger");
    bool offline;

    bytes32 constant ID = keccak256("fork-intent-1");
    bytes32 constant WANT = keccak256("0.01 ETH on base to user");
    bytes32 constant AID = keccak256("fork-ask-1");
    bytes32 constant GIVE = keccak256("1 NFT on apechain");

    function setUp() public {
        offline = vm.envOr("SKIP_FORK", false);
        if (offline) return;
        string memory url = vm.envOr("FORK_URL", DEFAULT_RPC);
        uint256 forkBlock = vm.envOr("FORK_BLOCK", uint256(0));
        if (forkBlock == 0) {
            // block.number on an Orbit chain is the L1 number, so ask the RPC for the L2 head
            bytes memory head = vm.rpc(url, "eth_blockNumber", "[]");
            for (uint256 i; i < head.length; ++i) {
                forkBlock = (forkBlock << 8) | uint8(head[i]);
            }
            forkBlock -= 50;
        }
        vm.createSelectFork(url, forkBlock);
        assertEq(block.chainid, 4663);
        assertGt(XMONEY.code.length, 0, "xMoney has no code");

        deployer = vm.addr(deployerPk);
        vm.deal(deployer, 1 ether);
        script = new DeployXSwap();
        // FOUNDER is an EOA that is not this test's broadcaster, so the script wants it typed twice
        (x, a) = script.deploy(deployerPk, FOUNDER, XMONEY, FANOUT_8010, FOUNDER);

        address[4] memory people = [user, solver, seller, buyer];
        for (uint256 i; i < people.length; ++i) {
            deal(XMONEY, people[i], 1_000e18);
            vm.startPrank(people[i]);
            xm.approve(address(x), type(uint256).max);
            xm.approve(address(a), type(uint256).max);
            vm.stopPrank();
        }
    }

    // ───────────────────────────── why the redeploy ─────────────────────────────

    function test_fork_liveV1_ownerIsForgeDefaultSender() public view {
        if (offline) return;
        assertEq(Ownable(LIVE_INTENTS).owner(), FORGE_DEFAULT_SENDER);
        assertEq(Ownable(LIVE_ASKS).owner(), FORGE_DEFAULT_SENDER);
        assertEq(Ownable(LIVE_INTENTS_FIRST).owner(), FORGE_DEFAULT_SENDER);
        // keccak256("foundry default caller"): an address derived from a string, not from a key
        assertEq(FORGE_DEFAULT_SENDER, address(uint160(uint256(keccak256("foundry default caller")))));
        assertEq(FORGE_DEFAULT_SENDER.code.length, 0);
    }

    function test_fork_liveV1_resolveRefusedToFounder() public {
        if (offline) return;
        vm.prank(FOUNDER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, FOUNDER));
        XSwapIntents(LIVE_INTENTS).resolve(ID, true);
        vm.prank(FOUNDER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, FOUNDER));
        XSwapAsks(LIVE_ASKS).resolve(AID, true);
    }

    // ───────────────────────────── the script ─────────────────────────────

    function test_fork_deploy_recordsExplicitOwner() public view {
        if (offline) return;
        assertEq(x.owner(), FOUNDER);
        assertEq(a.owner(), FOUNDER);
        assertEq(address(x.xmoney()), XMONEY);
        assertEq(address(a.xmoney()), XMONEY);
        assertEq(x.treasury(), FANOUT_8010);
        assertEq(a.treasury(), FANOUT_8010);
    }

    function test_fork_run_readsOwnerFromEnv() public {
        if (offline) return;
        vm.setEnv("PRIVATE_KEY", vm.toString(deployerPk));
        vm.setEnv("OWNER", vm.toString(FOUNDER));
        vm.setEnv("OWNER_CONFIRM", vm.toString(FOUNDER));
        (XSwapIntents i2, XSwapAsks a2) = script.run();
        assertEq(i2.owner(), FOUNDER);
        assertEq(a2.owner(), FOUNDER);
        assertTrue(i2.owner() != FORGE_DEFAULT_SENDER);
    }

    function test_fork_deploy_refusesDefaultSender() public {
        if (offline) return;
        vm.expectRevert(bytes("OWNER is forge-std DEFAULT_SENDER: nobody holds that key"));
        script.deploy(deployerPk, FORGE_DEFAULT_SENDER, XMONEY, FANOUT_8010, FORGE_DEFAULT_SENDER);
    }

    function test_fork_deploy_refusesZeroOwner() public {
        if (offline) return;
        vm.expectRevert(bytes("OWNER is address(0)"));
        script.deploy(deployerPk, address(0), XMONEY, FANOUT_8010, address(0));
    }

    function test_fork_deploy_refusesUnconfirmedEoa() public {
        if (offline) return;
        vm.expectRevert(bytes("OWNER is an EOA other than the broadcaster: set OWNER_CONFIRM to the same address"));
        script.deploy(deployerPk, FOUNDER, XMONEY, FANOUT_8010, address(0));
    }

    function test_fork_deploy_refusesNonSafeContract() public {
        if (offline) return;
        vm.expectRevert(bytes("OWNER is a contract but not a Safe")); // xMoney has no getThreshold()
        script.deploy(deployerPk, XMONEY, XMONEY, FANOUT_8010, XMONEY);
    }

    /// An EIP-7702 delegated EOA carries code but still has a key: treated as an EOA (typed twice), not as a contract.
    function test_fork_deploy_acceptsDelegatedEoa() public {
        if (offline) return;
        address eoa = makeAddr("delegatedOwner");
        vm.etch(eoa, abi.encodePacked(hex"ef0100", address(0xCc04506D439d338bdE8eBBb074F17A54B7673B95)));
        assertTrue(script.isDelegatedEoa(eoa));
        vm.expectRevert(bytes("OWNER is an EOA other than the broadcaster: set OWNER_CONFIRM to the same address"));
        script.deploy(deployerPk, eoa, XMONEY, FANOUT_8010, address(0));
        (XSwapIntents i2,) = script.deploy(deployerPk, eoa, XMONEY, FANOUT_8010, eoa);
        assertEq(i2.owner(), eoa);
    }

    function test_fork_deploy_acceptsBroadcasterAndSafe() public {
        if (offline) return;
        (XSwapIntents i2,) = script.deploy(deployerPk, deployer, XMONEY, FANOUT_8010, address(0));
        assertEq(i2.owner(), deployer);
        FakeSafe safe = new FakeSafe(FOUNDER);
        (XSwapIntents i3, XSwapAsks a3) = script.deploy(deployerPk, address(safe), XMONEY, FANOUT_8010, address(0));
        assertEq(i3.owner(), address(safe));
        assertEq(a3.owner(), address(safe));
    }

    /// Two-step handover: nothing changes until the new owner signs acceptOwnership(). A mistyped address, or a Safe
    /// that only exists on another chain, can never accept, so the old owner keeps ruling instead of nobody.
    function test_fork_owner_handOverIsTwoStep() public {
        if (offline) return;
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        x.transferOwnership(stranger);

        address typo = address(0xCAFE);
        vm.prank(FOUNDER);
        x.transferOwnership(typo);
        assertEq(x.owner(), FOUNDER, "a transfer alone hands nothing over");
        assertEq(x.pendingOwner(), typo);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        x.acceptOwnership();
        // the owner can still rule, and can point the handover somewhere else
        _disputedIntent();
        vm.prank(FOUNDER);
        x.resolve(ID, true);

        FakeSafe safe = new FakeSafe(FOUNDER);
        vm.prank(FOUNDER);
        a.transferOwnership(address(safe));
        vm.prank(address(safe));
        a.acceptOwnership();
        assertEq(a.owner(), address(safe));
        assertEq(a.pendingOwner(), address(0));
        vm.prank(FOUNDER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, FOUNDER));
        a.setParams(1 hours, 2 minutes, 10_000, 50, FANOUT_8010);
    }

    function test_fork_owner_cannotRenounce() public {
        if (offline) return;
        vm.prank(FOUNDER);
        vm.expectRevert(XSwapIntents.RenounceDisabled.selector);
        x.renounceOwnership();
        vm.prank(FOUNDER);
        vm.expectRevert(XSwapAsks.RenounceDisabled.selector);
        a.renounceOwnership();
        assertEq(x.owner(), FOUNDER);
        assertEq(a.owner(), FOUNDER);
    }

    /// deploy() derives the deployer from the key. It used to take one as an argument, and passing deployer == OWNER
    /// for any EOA skipped the OWNER_CONFIRM typo guard.
    function test_fork_deploy_cannotClaimToBeTheOwner() public {
        if (offline) return;
        address someEoa = makeAddr("notTheBroadcaster");
        vm.expectRevert(bytes("OWNER is an EOA other than the broadcaster: set OWNER_CONFIRM to the same address"));
        script.deploy(deployerPk, someEoa, XMONEY, FANOUT_8010, address(0));
    }

    // ───────────────────────────── intents: dispute and resolve ─────────────────────────────

    /// open 100, solver bids 90 with a 100% bond, claims, user disputes. Returns what the escrow actually took in.
    function _disputedIntent() internal returns (uint256 escrowIn) {
        uint256 b0 = xm.balanceOf(address(x));
        vm.prank(user);
        x.open(ID, 100e18, uint64(block.timestamp + 1 hours), WANT, "0.01 ETH on base");
        vm.prank(solver);
        x.bid(ID, 90e18);
        vm.warp(block.timestamp + x.bidding() + 1);
        vm.prank(solver);
        x.claim(ID, keccak256("fill tx"));
        vm.prank(user);
        x.dispute(ID, "never arrived");
        assertEq(uint8(x.get(ID).state), uint8(XSwapIntents.State.Disputed));
        escrowIn = xm.balanceOf(address(x)) - b0;
    }

    function test_fork_intents_resolveRefusedToEveryoneButOwner() public {
        if (offline) return;
        _disputedIntent();
        address[4] memory nope = [stranger, user, solver, FORGE_DEFAULT_SENDER];
        for (uint256 i; i < nope.length; ++i) {
            vm.prank(nope[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nope[i]));
            x.resolve(ID, true);
        }
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        x.setParams(10 minutes, 2_500, 0, stranger);
        assertEq(uint8(x.get(ID).state), uint8(XSwapIntents.State.Disputed));
    }

    function test_fork_intents_ownerResolvesForUser() public {
        if (offline) return;
        uint256 escrowIn = _disputedIntent();
        XSwapIntents.Intent memory it = x.get(ID);
        assertEq(it.amount + it.bond, escrowIn, "booked what arrived");
        vm.prank(FOUNDER);
        x.resolve(ID, true);
        assertEq(uint8(x.get(ID).state), uint8(XSwapIntents.State.Refunded));
        assertEq(x.credit(user), it.amount + it.bond); // escrow AND bond
        (, uint64 failed,,,,,) = x.rep(solver);
        assertEq(failed, 1);
        vm.prank(FOUNDER);
        vm.expectRevert(XSwapIntents.BadState.selector);
        x.resolve(ID, false); // one ruling per dispute
    }

    function test_fork_intents_ownerResolvesForSolver() public {
        if (offline) return;
        _disputedIntent();
        XSwapIntents.Intent memory it = x.get(ID);
        vm.prank(FOUNDER);
        x.resolve(ID, false);
        assertEq(uint8(x.get(ID).state), uint8(XSwapIntents.State.Settled));
        uint256 fee = it.ask * x.feeBps() / 10_000;
        assertEq(it.ask, 90e18);
        assertEq(x.credit(solver), it.ask - fee + it.bond);
        assertEq(x.credit(user), it.amount - it.ask); // what the bidding saved
        assertEq(x.credit(FANOUT_8010), fee);
        (,,,, uint64 lost,,) = x.rep(user);
        assertEq(lost, 1);
    }

    // ───────────────────────────── asks: dispute and resolve ─────────────────────────────

    function _disputedAsk() internal returns (uint256 escrowIn) {
        uint256 b0 = xm.balanceOf(address(a));
        vm.prank(seller);
        a.ask(AID, 50e18, uint64(block.timestamp + 1 hours), GIVE, "1 NFT on apechain");
        vm.prank(buyer);
        a.bid(AID, 60e18);
        vm.prank(seller);
        a.accept(AID);
        vm.prank(seller);
        a.delivered(AID, keccak256("transfer tx"));
        vm.prank(buyer);
        a.dispute(AID, "never arrived");
        assertEq(uint8(a.get(AID).state), uint8(XSwapAsks.State.Disputed));
        escrowIn = xm.balanceOf(address(a)) - b0;
    }

    function test_fork_asks_resolveRefusedToEveryoneButOwner() public {
        if (offline) return;
        _disputedAsk();
        address[4] memory nope = [stranger, seller, buyer, FORGE_DEFAULT_SENDER];
        for (uint256 i; i < nope.length; ++i) {
            vm.prank(nope[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nope[i]));
            a.resolve(AID, true);
        }
        assertEq(uint8(a.get(AID).state), uint8(XSwapAsks.State.Disputed));
    }

    function test_fork_asks_ownerResolvesForBuyer() public {
        if (offline) return;
        uint256 escrowIn = _disputedAsk();
        XSwapAsks.Ask memory ak = a.get(AID);
        assertEq(ak.pay, 60e18, "the bid price stays exact");
        assertEq(ak.pay + ak.bond, escrowIn, "booked what arrived");
        vm.prank(FOUNDER);
        a.resolve(AID, true);
        assertEq(uint8(a.get(AID).state), uint8(XSwapAsks.State.Cancelled));
        assertEq(a.credit(buyer), ak.pay + ak.bond); // pay AND bond back
        assertEq(a.credit(seller), 0);
    }

    function test_fork_asks_ownerResolvesForSeller() public {
        if (offline) return;
        _disputedAsk();
        XSwapAsks.Ask memory ak = a.get(AID);
        vm.prank(FOUNDER);
        a.resolve(AID, false);
        assertEq(uint8(a.get(AID).state), uint8(XSwapAsks.State.Settled));
        uint256 fee = ak.pay * a.feeBps() / 10_000;
        assertEq(a.credit(seller), ak.pay - fee + ak.bond); // payment plus the losing buyer's bond
        assertEq(a.credit(buyer), 0);
    }

    // ───────────────────────────── the money is really there ─────────────────────────────

    /// The real xMoney burns 1 bp of every transfer. The v1 bytecode booked the amount sent, so it owed more than it
    /// held; the redeploy books what arrived (_pull). This pins the burn so a change to it is noticed.
    function test_fork_xmoneyBurnsOnTransfer() public {
        if (offline) return;
        uint256 b0 = xm.balanceOf(stranger);
        vm.prank(user);
        xm.transfer(stranger, 100e18);
        assertEq(xm.balanceOf(stranger) - b0, 100e18 - 100e18 / 10_000);
    }

    /// Every path that ends in credit leaves the escrow holding at least what it owes.
    function test_fork_intents_solventAcrossPaths() public {
        if (offline) return;
        _disputedIntent();
        vm.prank(FOUNDER);
        x.resolve(ID, true);
        // a second intent settles normally, a third is refunded after its deadline with a live bid on it
        bytes32 id2 = keccak256("fork-intent-2");
        bytes32 id3 = keccak256("fork-intent-3");
        vm.prank(user);
        x.open(id2, 40e18, uint64(block.timestamp + 1 hours), WANT, "2");
        vm.prank(user);
        x.open(id3, 30e18, uint64(block.timestamp + 10 minutes), WANT, "3");
        vm.prank(solver);
        x.bid(id2, 39e18);
        vm.prank(solver);
        x.bid(id3, 29e18);
        vm.warp(block.timestamp + x.bidding() + 1);
        vm.prank(solver);
        x.claim(id2, keccak256("fill 2"));
        vm.prank(user);
        x.confirm(id2);
        vm.warp(block.timestamp + 11 minutes);
        vm.prank(stranger);
        x.refund(id3);
        uint256 owed = x.credit(user) + x.credit(solver) + x.credit(FANOUT_8010);
        assertGe(xm.balanceOf(address(x)), owed, "escrow owes more than it holds");
        address[3] memory who = [user, solver, FANOUT_8010];
        for (uint256 i; i < who.length; ++i) {
            vm.prank(who[i]);
            x.withdraw();
        }
        assertEq(xm.balanceOf(address(x)), 0);
    }

    function test_fork_asks_solventWhenOutbid() public {
        if (offline) return;
        vm.prank(seller);
        a.ask(AID, 50e18, uint64(block.timestamp + 1 hours), GIVE, "1 NFT");
        vm.prank(buyer);
        a.bid(AID, 55e18);
        vm.prank(user); // outbids: the first buyer's escrow and bond become credit
        a.bid(AID, 70e18);
        vm.prank(seller);
        a.accept(AID);
        vm.prank(seller);
        a.delivered(AID, keccak256("transfer"));
        vm.warp(block.timestamp + a.window() + 1);
        a.settle(AID);
        uint256 owed = a.credit(buyer) + a.credit(user) + a.credit(seller) + a.credit(FANOUT_8010);
        assertGe(xm.balanceOf(address(a)), owed, "escrow owes more than it holds");
        address[4] memory who = [buyer, user, seller, FANOUT_8010];
        for (uint256 i; i < who.length; ++i) {
            vm.prank(who[i]);
            a.withdraw();
        }
        assertEq(xm.balanceOf(address(a)), 0);
    }

    /// After the owner rules, everyone who is owed can pull it out of the real xMoney contract.
    function test_fork_intents_everyoneCanWithdrawAfterRuling() public {
        if (offline) return;
        _disputedIntent();
        vm.prank(FOUNDER);
        x.resolve(ID, false);
        address[3] memory owed = [solver, user, FANOUT_8010];
        for (uint256 i; i < owed.length; ++i) {
            vm.prank(owed[i]);
            x.withdraw();
        }
        assertEq(xm.balanceOf(address(x)), 0);
    }

    function test_fork_asks_everyoneCanWithdrawAfterRuling() public {
        if (offline) return;
        _disputedAsk();
        vm.prank(FOUNDER);
        a.resolve(AID, false);
        address[2] memory owed = [seller, FANOUT_8010];
        for (uint256 i; i < owed.length; ++i) {
            vm.prank(owed[i]);
            a.withdraw();
        }
        assertEq(xm.balanceOf(address(a)), 0);
    }
}
