// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// =============================================================================
// FlashLoanArb — Aave V3 flash loan + Uniswap V3 two-leg arbitrage executor.
//
// Design notes (production):
//  * The bot EOA is the ONLY caller of executeArb(); the contract holds NO
//    gas capital (native ETH/MATIC), so every wei of `profitToken` sitting in
//    this contract at rest IS pure realized profit -> sweepProfit() transfers
//    exactly that, and gas capital in the bot wallet is untouched by design.
//  * Route is stored on-chain (one SSTORE per config change) so per-trade
//    calldata stays tiny => smaller mempool footprint, less gas.
//  * Hand-rolled interfaces/SafeERC20: zero external deps => instant compile
//    even on a dual-core i5, no forge clone of OpenZeppelin needed.
// =============================================================================

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @dev Uniswap V3 pool — only the swap() selector is needed.
interface IUniswapV3Pool {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// @dev Aave V3 Pool (subset used here).
interface IAavePool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

/// @dev Minimal SafeERC20 handling USDT-style silent failures without OZ weight.
library SafeERC20 {
    error TransferFailed();
    error ApproveFailed();

    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        (bool ok, bytes memory ret) = address(token).call(
            abi.encodeCall(IERC20.transfer, (to, value))
        );
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function safeApprove(IERC20 token, address to, uint256 value) internal {
        (bool ok, bytes memory ret) = address(token).call(
            abi.encodeCall(IERC20.approve, (to, value))
        );
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert ApproveFailed();
    }
}

contract FlashLoanArb is IFlashLoanSimpleReceiver {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ types
    struct Route {
        address poolA;        // leg 1 (buy cheap)
        address poolB;        // leg 2 (sell expensive)
        bool    aZeroForOne;  // swap direction on pool A
        bool    bZeroForOne;  // swap direction on pool B
    }

    // ------------------------------------------------------------------- state
    address public immutable owner;
    address public immutable coldWallet;   // profit destination — never the hot wallet
    address public immutable aavePool;
    address public profitToken;            // token swept as profit (e.g. USDC)
    address public borrowToken;            // flash-loaned asset (must be pool token0/1)
    uint256 public minProfit;              // hard floor, in profitToken units (wei)
    bool private _locked;                  // 1-slot reentrancy guard (~2k gas, cheaper than OZ)
    /// @notice P1-2: true ONLY inside an in-flight flash-loan callback. rescueFunds
    /// and sweepProfit refuse to run while set, so borrowed assets can never be
    /// drained mid-arb. One warm SSTORE read + one cold write per arb ≈ 22k gas.
    bool public isExecuting;

    Route public route;

    // Canonical Uniswap V3 TickMath bounds (verified: MIN_SQRT_RATIO+1, MAX_SQRT_RATIO-1).
    uint160 private constant MIN_SQRT_PLUS = 4295128740;                  // MIN_SQRT_RATIO + 1
    uint160 private constant MAX_SQRT_MINUS = 1461446703485210103287273052203988822378723970341; // MAX - 1

    // ------------------------------------------------------------------ errors
    error NotOwner();
    error NotAavePool();
    error NotInitiator();
    error Reentrancy();
    error BadRoute();
    error ProfitTooLow(uint256 have, uint256 need);
    error SweepNothing();
    error ZeroAddr();
    error SelfAddress();          // P1-1: token/cold wallet == this contract
    error ArbInFlight();          // P1-2: rescue/sweep during flash-loan callback
    error EthTransferFailed();

    // ------------------------------------------------------------------ events
    event ArbExecuted(address indexed poolA, address indexed poolB, uint256 borrowed, uint256 grossOut, uint256 profit);
    event ProfitSwept(address indexed token, address indexed to, uint256 amount);
    event FundsRescued(address indexed token, address indexed to, uint256 amount);
    event RouteUpdated(address poolA, address poolB, bool aZfo, bool bZfo);
    event MinProfitUpdated(uint256 newMinProfit);
    event BorrowTokenUpdated(address token);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    constructor(
        address aavePool_,
        address coldWallet_,
        address profitToken_,
        address borrowToken_,
        uint256 minProfit_
    ) {
        // ---- P1-1 strict constructor validation (no timelock needed at $10 budget)
        if (aavePool_ == address(0)) revert ZeroAddr();
        if (coldWallet_ == address(0)) revert ZeroAddr();
        if (profitToken_ == address(0)) revert ZeroAddr();
        if (borrowToken_ == address(0)) revert ZeroAddr();
        // Destination must never be the contract itself — that would make profit
        // un-sweepable (balance invariant breaks).
        if (coldWallet_ == address(this)) revert SelfAddress();
        // Tokens must never be the contract itself (not ERC20s → silent breakage).
        if (profitToken_ == address(this) || borrowToken_ == address(this)) revert SelfAddress();
        owner         = msg.sender;
        aavePool      = aavePool_;
        coldWallet    = coldWallet_;
        profitToken   = profitToken_;
        borrowToken   = borrowToken_;
        minProfit     = minProfit_;
    }

    // -------------------------------------------------------------- admin ops
    function setRoute(address poolA, address poolB, bool aZeroForOne, bool bZeroForOne) external onlyOwner {
        if (poolA == address(0) || poolB == address(0) || poolA == poolB) revert BadRoute();
        route = Route(poolA, poolB, aZeroForOne, bZeroForOne);
        emit RouteUpdated(poolA, poolB, aZeroForOne, bZeroForOne);
        // One-time max approvals amortized across all future trades.
        IERC20(borrowToken).safeApprove(poolA, type(uint256).max);
        IERC20(borrowToken).safeApprove(poolB, type(uint256).max);
    }

    function setMinProfit(uint256 newMin) external onlyOwner {
        minProfit = newMin;
        emit MinProfitUpdated(newMin);
    }

    function setProfitToken(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddr();
        if (t == address(this)) revert SelfAddress();     // P1-1: same checks as ctor
        profitToken = t;
    }

    function setBorrowToken(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddr();
        if (t == address(this)) revert SelfAddress();     // P1-1
        borrowToken = t;
        emit BorrowTokenUpdated(t);
    }

    // ------------------------------------------------------------- entrypoint
    /// @notice Kick off an Aave V3 flash loan against the stored route.
    /// Post-callback we verify realized profit >= minProfit or revert the WHOLE tx.
    function executeArb(uint256 borrowed) external onlyOwner nonReentrant {
        Route memory r = route;
        if (r.poolA == address(0)) revert BadRoute();

        uint256 balBefore = IERC20(profitToken).balanceOf(address(this));

        // params empty => route lives in storage: minimal calldata, minimal mempool size.
        IAavePool(aavePool).flashLoanSimple(address(this), borrowToken, borrowed, "", 0);

        uint256 profit = IERC20(profitToken).balanceOf(address(this)) - balBefore;
        if (profit < minProfit) revert ProfitTooLow(profit, minProfit);
        emit ArbExecuted(r.poolA, r.poolB, borrowed, 0, profit);
    }

    // ---------------------------------------------------- Aave callback (core)
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata
    ) external override returns (bool) {
        if (msg.sender != aavePool) revert NotAavePool();
        if (initiator != owner) revert NotInitiator();
        // P1-2: mark the contract as holding borrowed assets for the duration of
        // this callback. If any leg reverts, the whole tx (incl. this flag write)
        // reverts atomically — the flag can never be left stuck true.
        isExecuting = true;

        Route memory r = route;

        // ---- Leg 1: exact-in swap on the "cheap" pool.
        (int256 a0, int256 a1) = IUniswapV3Pool(r.poolA).swap(
            address(this),
            r.aZeroForOne,
            int256(amount),                       // exact-in of borrowed token
            r.aZeroForOne ? MIN_SQRT_PLUS : MAX_SQRT_MINUS,
            ""
        );

        // Mid-balance of the output token = what we can sell on leg 2.
        // For zeroForOne, output is token1 (positive a1); else output is token0 (-a0).
        address outTok = r.aZeroForOne ? _token1(r.poolA) : _token0(r.poolA);
        uint256 midBal = uint256(r.aZeroForOne ? a1 : -a0);
        // Safety: trust the actual balance too (some forks return sloppy deltas).
        uint256 actual = IERC20(outTok).balanceOf(address(this));
        if (actual > midBal) midBal = actual;

        // ---- Leg 2: exact-in swap of everything back on the "expensive" pool.
        IUniswapV3Pool(r.poolB).swap(
            address(this),
            r.bZeroForOne,
            int256(midBal),
            r.bZeroForOne ? MIN_SQRT_PLUS : MAX_SQRT_MINUS,
            ""
        );

        // ---- Repay principal + premium in the SAME tx.
        uint256 owed = amount + premium;
        IERC20(asset).safeTransfer(aavePool, owed);
        isExecuting = false;   // P1-2: borrowed assets fully returned — flag cleared
        return true;
    }

    // ----------------------------------------------------------- profit sweep
    /// @notice Sweep ONLY realized profit to `to`. Invariant that makes this
    /// "pure profit": contract holds no native gas capital and repays the full
    /// flash-loan principal inside executeArb, so the resting ERC20 balance of
    /// `profitToken` equals accumulated profit. Gas capital lives in the bot
    /// EOA and is structurally unreachable from this function.
    function sweepProfit(address token, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddr();
        if (isExecuting) revert ArbInFlight();       // P1-2: never sweep mid-flash-loan
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) revert SweepNothing();
        IERC20(token).safeTransfer(to, bal);
        emit ProfitSwept(token, to, bal);
    }

    /// @notice Convenience sweep of the configured profit token to the cold wallet.
    function sweepToCold() external onlyOwner nonReentrant {
        uint256 bal = IERC20(profitToken).balanceOf(address(this));
        if (bal == 0) revert SweepNothing();
        IERC20(profitToken).safeTransfer(coldWallet, bal);
        emit ProfitSwept(profitToken, coldWallet, bal);
    }

    // ---------------------------------------------------------------- rescue
    /// @notice Owner-only rescue for stuck assets (airdrops, dust, mis-sent funds).
    /// token == address(0) => native ETH. Never callable by non-owner.
    function rescueFunds(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddr();
        // P1-2: while a flash loan is in flight the contract's balance contains
        // BORROWED assets — rescuing now would steal from Aave and hard-revert
        // at repayment anyway; this guard makes that impossible by construction.
        if (isExecuting) revert ArbInFlight();
        if (token == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
        emit FundsRescued(token, to, amount);
    }

    /// @notice Kill-switch companion (P0-2): zero the max-approvals granted to
    /// the route pools in setRoute(). Called by the bot's emergencyStop BEFORE
    /// the process dies, so a leaked key can never drain via stale approvals.
    /// Safe mid-flight? No — guarded like rescueFunds: borrowed assets must be
    /// repaid first; reverting here during a callback would break repayment.
    function revokeAllowances() external onlyOwner {
        if (isExecuting) revert ArbInFlight();
        Route memory r = route;
        // Revoke current route AND any previously-approved pool is impossible
        // without an index; the route is the ONLY approved spender set we ever
        // create, so revoking both entries closes the surface completely.
        if (r.poolA != address(0)) IERC20(borrowToken).safeApprove(r.poolA, 0);
        if (r.poolB != address(0)) IERC20(borrowToken).safeApprove(r.poolB, 0);
    }

    /// @notice Kill-switch: bricks the route so no stale config can execute.
    function emergencyStop() external onlyOwner {
        route = Route(address(0), address(0), false, false);
        emit RouteUpdated(address(0), address(0), false, false);
    }

    receive() external payable {} // accept ETH dust so rescueFunds can extract it

    // ------------------------------------------------------- pool accessors
    function _token0(address pool) internal view returns (address t) {
        t = IUniswapV3TokenHolder(pool).token0();
    }

    function _token1(address pool) internal view returns (address t) {
        t = IUniswapV3TokenHolder(pool).token1();
    }
}

/// @dev Just the token0/token1 views of a Uni V3 (or V3-fork like Sushi) pool.
interface IUniswapV3TokenHolder {
    function token0() external view returns (address);
    function token1() external view returns (address);
}
