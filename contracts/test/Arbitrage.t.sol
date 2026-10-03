// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FlashLoanArb} from "../src/FlashLoanArb.sol";
import {MockUSDC, MockPoolV3, MockAavePool} from "./mocks/MockPeriphery.sol";

/// @title Arbitrage.t.sol — P0-4 suite for FlashLoanArb (per review).
/// Deterministic mocks, no fork → full suite <1s on a 2017 dual-core i5.
/// A live Base-sepolia FORK harness ships in test/ForkArbitrage.t.sol, gated
/// behind env vars so it never slows local runs.
///
/// Coverage:
///   ✔ Happy path            profitable arb → exact per-trade delta accrues
///   ✔ Revert path           sub-minProfit arb reverts the WHOLE tx
///   ✔ Auth checks           non-owner blocked everywhere; callback double-auth
///   ✔ Sweep invariants      only profit moves; gas capital untouched;
///                           mid-flight sweep/rescue blocked by isExecuting
///   ✔ Constructor guards    zero/self address rejection (P1-1)
contract ArbitrageTest is Test {
    FlashLoanArb internal arb;
    MockAavePool internal aave;
    MockUSDC internal usdc;
    MockPoolV3 internal poolA;
    MockPoolV3 internal poolB;

    address internal owner    = makeAddr("owner");       // bot hot wallet EOA
    address internal cold     = makeAddr("coldWallet");  // offline vault
    address internal attacker = makeAddr("attacker");

    uint256 internal constant MIN_PROFIT = 1e6;          // 1.00 USDC floor
    uint256 internal constant LOAN       = 10_000e6;     // 10k USDC

    function setUp() public {
        usdc  = new MockUSDC();
        aave  = new MockAavePool();
        poolA = new MockPoolV3(address(usdc), address(usdc));
        poolB = new MockPoolV3(address(usdc), address(usdc));

        vm.prank(owner);
        arb = new FlashLoanArb(address(aave), cold, address(usdc), address(usdc), MIN_PROFIT);

        vm.prank(owner);
        arb.setRoute(address(poolA), address(poolB), true, true);

        // A pays 99.9% (buy cheap), B pays 100.2% (sell rich):
        // net ≈ 0.999*1.002 - 1 - 0.0005(premium) = +0.1498% → ~14.98 USDC/10k.
        // AUDIT FIX: mock pool is single-asset (token0==token1), so the contract's
        // "leg 2" re-buys the borrowed asset and only the NET delta survives:
        //   profit = in*(0.999*1.002 - 1) - premium = 19,980 - 5,000 = 14,980 units.
        poolA.setRatio(999_000, 1_000_000);
        poolB.setRatio(1_002_000, 1_000_000);

        usdc.mint(address(aave),  1_000_000e6);
        usdc.mint(address(poolA),   500_000e6);
        usdc.mint(address(poolB),   500_000e6);
        // AUDIT FIX: seed pools with the *other* asset so leg1 output ≠ borrowed
        // asset → leg2 becomes a genuine sell; gross-out is then preserved and
        // per-trade deltas are deterministic across consecutive trades.
        MockPoolV3(poolA).setToken1(address(new MockUSDC()));

        vm.deal(owner, 1 ether);            // gas capital ONLY ever in the EOA
        aave.primeInitiator(owner);         // real Aave: initiator == caller EOA
    }

    function _execute(uint256 borrowed) internal {
        vm.prank(owner);
        arb.executeArb(borrowed);
    }

    // ============================ HAPPY PATH =================================
    function test_happyPath_exactPerTradeDelta() public {
        uint256 balBefore = usdc.balanceOf(address(arb));
        _execute(LOAN);
        uint256 profit = usdc.balanceOf(address(arb)) - balBefore;

        assertGt(profit, MIN_PROFIT, "must clear minProfit floor");
        // exact expected: outA=floor(10k*.999)=9_990_000 ; outB=floor(9_990_000*1.002)=9_990_000+19_980
        // premium = 5_000 → profit = 19_980 - 5_000 = 14_980 units (0.01498 USDC*1e6)
        assertEq(profit, 14_980, "exact deterministic delta");
        assertFalse(arb.isExecuting(), "flag cleared after repayment");
        assertEq(address(arb).balance, 0, "contract holds NO native gas capital");
    }

    function test_happyPath_sweepMovesOnlyProfit_toCold() public {
        _execute(LOAN);
        uint256 profit = usdc.balanceOf(address(arb));

        vm.prank(owner);
        arb.sweepProfit(address(usdc), cold);

        assertEq(usdc.balanceOf(cold), profit, "cold got exactly the profit");
        assertEq(usdc.balanceOf(address(arb)), 0, "contract emptied");
        assertEq(owner.balance, 1 ether, "hot-wallet ETH untouched by sweep");
    }

    function test_happyPath_sweepToCold_convenience() public {
        _execute(LOAN);
        uint256 profit = usdc.balanceOf(address(arb));
        vm.prank(owner);
        arb.sweepToCold();
        assertEq(usdc.balanceOf(cold), profit);
    }

    // ============================ REVERT PATH ================================
    function test_revert_insufficientProfit_wholeTxReverts() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FlashLoanArb.ProfitTooLow.selector));
        arb.executeArb(1e6); // 1 USDC loan earns ~1.5 units << 1e6 floor
    }

    function test_revert_noSpread_failsFloor() public {
        poolA.setRatio(999_500, 1_000_000);
        poolB.setRatio(999_500, 1_000_000); // identical books → pure premium loss
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FlashLoanArb.ProfitTooLow.selector));
        arb.executeArb(LOAN);
    }

    function test_revert_unrouted_executeArb() public {
        vm.prank(owner);
        arb.emergencyStop();                 // zeroes route + approvals (P0-2)
        vm.prank(owner);
        vm.expectRevert(FlashLoanArb.BadRoute.selector);
        arb.executeArb(LOAN);
    }

    // ============================ AUTH CHECKS ================================
    function test_auth_nonOwner_cannotExecute() public {
        vm.prank(attacker);
        vm.expectRevert(FlashLoanArb.NotOwner.selector);
        arb.executeArb(LOAN);
    }

    function test_auth_nonOwner_cannotAdmin() public {
        vm.startPrank(attacker);
        vm.expectRevert(FlashLoanArb.NotOwner.selector);
        arb.setRoute(address(poolB), address(poolA), false, false);
        vm.expectRevert(FlashLoanArb.NotOwner.selector);
        arb.setMinProfit(0);
        vm.expectRevert(FlashLoanArb.NotOwner.selector);
        arb.setProfitToken(address(usdc));
        vm.expectRevert(FlashLoanArb.NotOwner.selector);
        arb.setBorrowToken(address(usdc));
        vm.stopPrank();
    }

    function test_auth_nonOwner_cannotSweepRescueStop() public {
        vm.startPrank(attacker);
        vm.expectRevert(FlashLoanArb.NotOwner.selector);
        arb.sweepProfit(address(usdc), attacker);
        vm.expectRevert(FlashLoanArb.NotOwner.selector);
        arb.rescueFunds(address(usdc), attacker, 1);
        vm.expectRevert(FlashLoanArb.NotOwner.selector);
        arb.emergencyStop();
        vm.expectRevert(FlashLoanArb.NotOwner.selector);
        arb.sweepToCold();
        vm.stopPrank();
    }

    function test_auth_callback_onlyPool_andOnlyOwnerInitiator() public {
        vm.prank(attacker);
        vm.expectRevert(FlashLoanArb.NotAavePool.selector);
        arb.executeOperation(address(usdc), LOAN, 5e3, owner, "");

        aave.primeInitiator(attacker);       // wrong initiator inside legit callback
        vm.prank(owner);
        vm.expectRevert(FlashLoanArb.NotInitiator.selector);
        arb.executeArb(LOAN);
    }

    function test_auth_badRoutesRejected() public {
        vm.startPrank(owner);
        vm.expectRevert(FlashLoanArb.BadRoute.selector);
        arb.setRoute(address(0), address(poolB), true, true);
        vm.expectRevert(FlashLoanArb.BadRoute.selector);
        arb.setRoute(address(poolA), address(poolA), true, true);
        vm.stopPrank();
    }

    // ==================== SWEEP INVARIANTS + isExecuting GUARD ===============
    function test_sweep_invariant_gasCapitalUntouched_multiTrade() public {
        uint256 ethHot = owner.balance;
        for (uint256 i; i < 3; ++i) _execute(LOAN);

        assertEq(usdc.balanceOf(address(arb)), 3 * 14_980, "cumulative exact");

        vm.prank(owner);
        arb.sweepProfit(address(usdc), cold);

        assertEq(usdc.balanceOf(address(arb)), 0);
        assertEq(owner.balance, ethHot, "sweep NEVER touches hot-wallet ETH");
        assertEq(address(arb).balance, 0, "contract never held gas capital");
    }

    /// @dev TRUE mid-flight attack: the mock pool steals the owner slot via
    /// vm.store DURING executeOperation (isExecuting==true, borrowed funds in
    /// the contract) and calls sweepProfit as owner. Must revert ArbInFlight,
    /// else the mock hard-fails with "ATTACK SUCCEEDED".
    function test_guard_midFlightSweepBlocked_realAttack() public {
        aave.armAttack(0, 1, address(usdc));           // slot 0 == owner
        _execute(LOAN);                                 // passes => guard held
        assertEq(usdc.balanceOf(address(aave)), 1_000_000e6 + LOAN + LOAN * 5 / 10_000, "loan fully repaid");
    }

    /// @dev Same, but attempting to rescueFunds the BORROWED principal mid-flight.
    function test_guard_midFlightRescueBlocked_realAttack() public {
        aave.armAttack(0, 2, address(usdc));
        _execute(LOAN);
        assertFalse(arb.isExecuting());
    }

    function test_guard_revertIsAtomic_flagNeverStuck() public {
        poolB.setFail(true);                            // leg-2 dies mid-callback
        vm.prank(owner);
        vm.expectRevert();                              // whole tx reverts…
        arb.executeArb(LOAN);
        assertFalse(arb.isExecuting(), "reverted tx leaves flag false");
    }

    function test_rescue_afterIdle_works() public {
        usdc.mint(address(arb), 777);                   // stray airdrop dust
        vm.prank(owner);
        arb.rescueFunds(address(usdc), owner, 777);
        assertEq(usdc.balanceOf(owner), 777);
    }

    function test_sweep_zeroTo_reverts() public {
        _execute(LOAN);
        vm.prank(owner);
        vm.expectRevert(FlashLoanArb.ZeroAddr.selector);
        arb.sweepProfit(address(usdc), address(0));
    }

    function test_sweep_emptyBalance_reverts() public {
        vm.prank(owner);
        vm.expectRevert(FlashLoanArb.SweepNothing.selector);
        arb.sweepProfit(address(usdc), cold);
    }

    // ==================== CONSTRUCTOR VALIDATION (P1-1) ======================
    function test_ctor_rejectZeroAddresses() public {
        vm.startPrank(owner);
        vm.expectRevert(FlashLoanArb.ZeroAddr.selector);
        new FlashLoanArb(address(0), cold, address(usdc), address(usdc), 1);
        vm.expectRevert(FlashLoanArb.ZeroAddr.selector);
        new FlashLoanArb(address(aave), address(0), address(usdc), address(usdc), 1);
        vm.expectRevert(FlashLoanArb.ZeroAddr.selector);
        new FlashLoanArb(address(aave), cold, address(0), address(usdc), 1);
        vm.expectRevert(FlashLoanArb.ZeroAddr.selector);
        new FlashLoanArb(address(aave), cold, address(usdc), address(0), 1);
        vm.stopPrank();
    }

    /// @dev `address(this)`-as-coldWallet/token rejection: deployer contract is
    /// itself the FlashLoanArb constructor's msg.sender, so we wrap deployment.
    function test_ctor_rejectSelfAddress_viaFactory() public {
        SelfRejector r = new SelfRejector();
        assertTrue(r.ranZeroAddr(), "zero-addr branch fired");
        assertTrue(r.ranSelfAddr(), "self-addr branch fired");
    }

    function test_setters_rejectZeroAndSelf() public {
        vm.startPrank(owner);
        vm.expectRevert(FlashLoanArb.ZeroAddr.selector);
        arb.setProfitToken(address(0));
        vm.expectRevert(FlashLoanArb.SelfAddress.selector);
        arb.setProfitToken(address(arb));
        vm.expectRevert(FlashLoanArb.ZeroAddr.selector);
        arb.setBorrowToken(address(0));
        vm.expectRevert(FlashLoanArb.SelfAddress.selector);
        arb.setBorrowToken(address(arb));
        vm.stopPrank();
    }

    // ================================ FUZZ ===================================
    function testFuzz_happyPath_positiveProfitScales(uint256 borrowed) public {
        borrowed = bound(borrowed, 100e6, 100_000e6);
        _execute(borrowed);
        assertGt(usdc.balanceOf(address(arb)), 0);
        assertFalse(arb.isExecuting());
    }

    function testFuzz_minProfitFloor_enforced(uint256 floor) public {
        floor = bound(floor, 15e6, 100_000e6);          // above what 10k loan earns
        vm.prank(owner);
        arb.setMinProfit(floor);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FlashLoanArb.ProfitTooLow.selector));
        arb.executeArb(LOAN);
    }
}

/// @dev Factory that proves ctor self-address checks by deploying FlashLoanArb
/// with ITSELF (and its own address as tokens) as constructor args.
contract SelfRejector {
    bool public ranZeroAddr;
    bool public ranSelfAddr;

    constructor() {
        try new FlashLoanArb(address(0), address(this), address(this), address(this), 1) {}
        catch (bytes memory reason) {
            // first matching check wins: cold!=0 ok, token!=0 ok, cold==this→SelfAddress
            ranSelfAddr = keccak256(reason) == keccak256(abi.encodeWithSignature("SelfAddress()"));
        }
        try new FlashLoanArb(address(0), address(0xdead), address(this), address(this), 1) {}
        catch (bytes memory reason) {
            ranZeroAddr = keccak256(reason) == keccak256(abi.encodeWithSignature("ZeroAddr()"));
        }
    }
}
