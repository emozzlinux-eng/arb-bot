// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Minimal {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @dev 6-decimal token, open mint, USDC-like set-to-value approve().
contract MockUSDC {
    string public name = "Mock USDC";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external returns (bool) {
        require(balanceOf[msg.sender] >= a, "bal");
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        require(allowance[f][msg.sender] >= a, "allow");
        allowance[f][msg.sender] -= a;
        require(balanceOf[f] >= a, "bal");
        balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
    function approve(address spender, uint256 a) external returns (bool) {
        allowance[msg.sender][spender] = a; return true;
    }
}

/// @dev Mock Uniswap V3 pool (single-asset test pools: token0 == token1).
///      out = in * num/den. failSwap forces mid-callback reverts.
contract MockPoolV3 {
    address public token0;
    address public token1;
    uint256 public outNum = 1_000_000;
    uint256 public outDen = 1_000_000;
    bool public failSwap;

    constructor(address t0_, address t1_) { token0 = t0_; token1 = t1_; }
    function setRatio(uint256 n, uint256 d) external { outNum = n; outDen = d; }
    function setFail(bool f) external { failSwap = f; }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata)
        external returns (int256 amount0, int256 amount1)
    {
        // Enforce exact TickMath bounds → proves FlashLoanArb constants are valid.
        if (zeroForOne) {
            require(sqrtPriceLimitX96 > 4295128739 && sqrtPriceLimitX96 < 1461446703485210103287273052203988822378723970342, "limit");
        } else {
            require(sqrtPriceLimitX96 < 1461446703485210103287273052203988822378723970342 && sqrtPriceLimitX96 > 4295128739, "limit");
        }
        require(!failSwap, "pool down");
        require(amountSpecified > 0, "amt");
        uint256 amtIn = uint256(amountSpecified);
        IERC20Minimal(token0).transferFrom(msg.sender, address(this), amtIn);
        uint256 amtOut = amtIn * outNum / outDen;
        IERC20Minimal(token0).transfer(recipient, amtOut);
        return (-int256(amtIn), int256(amtOut));
    }
}

interface IFlashLoanReceiverLike {
    function executeOperation(address, uint256, uint256, address, bytes calldata) external returns (bool);
}

/// @dev Aave V3 flashLoanSimple mock + P1-2 ATTACK HARNESS.
///      When armed (`armAttack`), DURING the callback window — while the
///      receiver provably holds BORROWED funds and isExecuting==true — it
///      temporarily assumes the receiver's owner role via vm.store (a
///      test-only cheat standing in for a compromised-owner key scenario),
///      calls sweepProfit/rescueFunds, and REQUIRES an ArbInFlight revert.
///      If either admin call ever succeeds mid-flight, this mock hard-reverts
///      with "ATTACK SUCCEEDED" → the forge test fails loudly.
interface VmLike {
    function store(address, bytes32, bytes32) external;
    function load(address, bytes32) external view returns (bytes32);
}

contract MockAavePool {
    uint16 public constant PREMIUM_BPS = 5;              // 0.05% Aave V3 default
    address private _initiator;

    VmLike internal constant VM = VmLike(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    // one-shot attack wiring (test-only)
    uint256 public ownerSlot;        // storage slot of target.owner
    uint8  public attackKind;        // 0 none | 1 sweepProfit | 2 rescueFunds
    address public profitToken;

    function primeInitiator(address who) external { _initiator = who; }
    function armAttack(uint256 ownerSlot_, uint8 kind, address token) external {
        ownerSlot = ownerSlot_; attackKind = kind; profitToken = token;
    }

    function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16) external {
        MockUSDC(asset).mint(receiver, amount);
        uint256 premium = amount * PREMIUM_BPS / 10_000;
        uint256 owed = amount + premium;

        if (attackKind != 0) {
            uint8 kind = attackKind;
            attackKind = 0;                                   // one-shot
            bytes32 realOwner = VM.load(receiver, bytes32(ownerSlot));
            VM.store(receiver, bytes32(ownerSlot), bytes32(uint256(uint160(address(this)))));
            bool blocked;
            if (kind == 1) {
                (bool ok0, bytes memory ret0) = receiver.call(
                    abi.encodeWithSignature("sweepProfit(address,address)", profitToken, address(this)));
                // sweepProfit is nonReentrant: a mid-flight call from the pool hits the
                // Reentrancy mutex FIRST. Either ArbInFlight or Reentrancy is a valid block.
                blocked = !ok0 && ret0.length == 4 &&
                    (bytes4(ret0) == bytes4(keccak256("ArbInFlight()")) ||
                     bytes4(ret0) == bytes4(keccak256("Reentrancy()")));
            } else {
                (bool ok0, bytes memory ret0) = receiver.call(
                    abi.encodeWithSignature("rescueFunds(address,address,uint256)", asset, address(this), amount));
                blocked = !ok0 && ret0.length == 4 && bytes4(ret0) == bytes4(keccak256("ArbInFlight()"));
            }
            VM.store(receiver, bytes32(ownerSlot), realOwner);          // restore honest owner
            require(blocked, "ATTACK SUCCEEDED: admin fn ran mid-flash-loan!");
        }

        bool ok = IFlashLoanReceiverLike(receiver).executeOperation(asset, amount, premium, _initiator, params);
        require(ok, "callback false");
        require(MockUSDC(asset).balanceOf(address(this)) >= owed, "not repaid");
    }
}
