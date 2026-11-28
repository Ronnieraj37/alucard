// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CurrencySettler} from "@openzeppelin/uniswap-hooks/src/utils/CurrencySettler.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Position} from "@uniswap/v4-core/src/libraries/Position.sol";

import {OrderState} from "./libraries/OrderState.sol";
import {Rules} from "./Rules.sol";

/// @title ConditionalOrders: LP positions that run their owner's strategy
/// @notice An LP adds liquidity through this contract together with a strategy. This contract owns the position in
/// the PoolManager (owner = this contract, salt = orderId), in any pool `Rules` knows (two listed tokens, no hook or
/// the limit-order hook). Anyone may call `execute`; the contract asks `Rules` whether the condition is true and
/// whether the pool's price is near Chainlink (so nobody can push it to fire a strategy), runs the steps, pays the
/// caller the owner's keeper fee out of what the run moved, and sends everything else to the owner. The owner can
/// cancel at any time.
///
/// A strategy is one leg or two. A leg is where the tokens are: a position (in a fixed range, or one centred on the
/// price when it is entered) or waiting, with the tokens held for the order. Each leg has its own two sides. A side
/// with ACT_MOVE takes everything out of the leg it is in and puts it into the other leg, which then becomes the live
/// one: for example "below my range, swap to USDC and add it to USDC/USDT; once ETH is back in my range, come back".
///
/// Payouts never block an order: if sending to the owner fails (a contract that cannot take ETH, a blacklisted
/// address), the amount is kept here as `owed` and the owner withdraws it later to any address.
contract ConditionalOrders is IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;
    using CurrencySettler for Currency;
    using OrderState for OrderState.Side;

    error NotPoolManager();
    error InvalidOrder();
    error NotOwner();
    error UnknownOrder();
    error Expired();
    error SideOff();
    error ConditionNotMet();
    error NotHeldLongEnough();
    error TooSoon();
    error NoPrice();
    error NothingToEnter();
    error NothingToPoke();
    error TooMuchIn();
    error BadMsgValue();
    error RefundFailed();
    error NothingOwed();

    uint256 internal constant BPS = 10_000;
    uint8 public constant MAX_KEEPER_FEE_BPS = 100;
    /// @notice A side runs at most once in this many seconds after its last run (kept to the minute, rounded up, so
    /// in practice one to two minutes). A run that leaves its condition true (a ladder the price jumped past) runs
    /// again then, and no transaction can loop a side.
    uint256 public constant MIN_GAP = 60;

    /// @dev Gas given to the owner's address when sending it ETH. Enough for a smart wallet's receive; a contract that
    /// needs more gets its ETH as `owed`.
    uint256 public constant PAYOUT_GAS = 30_000;

    /// @dev Three storage slots per order.
    struct Order {
        // slot 0 (160 + 24 + 32 + 8 + 8 = 232 bits)
        address owner;
        uint24 poolIndex; // pool of the live leg: positions and swaps are in it
        uint32 expiry;
        uint8 keeperFeeBps; // what the keeper is paid per run, in bps of the tokens the run takes out
        uint8 maxSlippage; // swaps stop this far past the price before them, in steps of 10 ticks (~0.1%)
        // slots 1 and 2, rewritten when the order runs: the live leg's sides, one OrderState word each
        uint256 lowerState;
        uint256 upperState;
    }

    /// @dev The second leg of a two-leg strategy. Only those orders have one.
    struct Plan {
        OrderState.Leg here; // the live leg
        OrderState.Leg there; // the other one
        uint256 thereLower; // the other leg's sides, kept as they were while it waits
        uint256 thereUpper;
        uint128 held0; // tokens held for the order while it waits (LEG_IDLE), as ERC-6909 claims
        uint128 held1;
    }

    struct CreateParams {
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint128 amount0Max;
        uint128 amount1Max;
        uint32 expiry;
        uint8 keeperFeeBps;
        uint8 maxSlippage; // steps of 10 ticks
        uint256 lower; // the sides, each packed in one word (Rules.encode packs a Side)
        uint256 upper;
        // second leg (away.kind 0 = a one-leg order: home, away and their sides must be zero)
        OrderState.Leg home; // how to re-enter this position when coming back: LEG_RANGE (this range) or LEG_CENTERED
        OrderState.Leg away;
        uint256 awayLower;
        uint256 awayUpper;
    }

    /// @dev New rule for the live leg of an order. Its position and the other leg stay as they are.
    struct UpdateParams {
        uint32 expiry;
        uint8 keeperFeeBps;
        uint8 maxSlippage;
        uint256 lower; // packed sides (Rules.encode)
        uint256 upper;
    }

    enum Op {
        Create,
        Execute,
        Cancel
    }

    /// @dev Working data for one execution, kept in memory to avoid stack limits.
    struct Run {
        uint256 orderId;
        bool upper;
        address keeper;
        Order order;
        OrderState.State st;
        PoolKey key; // the pool the run starts in: the keeper is paid in its tokens
        PoolKey to; // the pool the run ends in (a move may change it)
        bytes32 salt;
        uint256 w0; // tokens the actions may use
        uint256 w1;
        uint256 reserve0; // the keeper's fee
        uint256 reserve1;
    }

    IPoolManager public immutable poolManager;
    Rules public immutable rules; // the pool table, conditions, price checks and strategy checks

    uint256 public nextOrderId = 1;
    mapping(uint256 orderId => Order) internal _orders;
    mapping(uint256 orderId => Plan) internal _plans;
    /// @dev Every order id an address created (closed ones included; their owner reads as zero).
    mapping(address owner => uint256[] orderIds) internal _ordersOf;
    /// @dev When each side's condition was first seen true by `poke` (for a side with a hold): lower side in the low
    /// 32 bits, upper side in the high 32. 0 = not seen true yet.
    mapping(uint256 orderId => uint64) internal _armed;
    /// @notice Payouts that could not be sent, waiting for the owner to withdraw them.
    mapping(address owner => mapping(Currency currency => uint256 amount)) public owed;

    event OrderCreated(
        uint256 indexed orderId,
        address indexed owner,
        uint24 indexed poolIndex,
        uint32 expiry,
        uint8 keeperFeeBps,
        uint8 maxSlippage,
        uint256 lowerState,
        uint256 upperState
    );
    event OrderExecuted(
        uint256 indexed orderId, bool upper, address indexed keeper, uint256 lowerState, uint256 upperState
    );
    /// @notice The order moved to its other leg (now live in `poolIndex`).
    event OrderMoved(
        uint256 indexed orderId,
        bool upper,
        address indexed keeper,
        uint24 poolIndex,
        uint8 kind,
        uint256 lowerState,
        uint256 upperState
    );
    event OrderClosed(uint256 indexed orderId);
    event OrderUpdated(uint256 indexed orderId, uint256 lowerState, uint256 upperState);
    event OrderPoked(uint256 indexed orderId, bool upper, uint256 state);
    event PayoutHeld(address indexed owner, Currency indexed currency, uint256 amount);
    event Withdrawn(address indexed owner, Currency indexed currency, address to, uint256 amount);

    constructor(IPoolManager _poolManager, Rules _rules) {
        poolManager = _poolManager;
        rules = _rules;
    }

    /// @dev Native ETH arrives here from the PoolManager when a payout is taken to this contract.
    receive() external payable {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    // ---------------------------------------------------------------
    // User entry points
    // ---------------------------------------------------------------

    /// @notice Add liquidity with a strategy attached. Approve this contract for both tokens first (for native ETH as
    /// currency0, send it as msg.value; anything not used is refunded).
    function createOrder(CreateParams calldata p) external payable returns (uint256 orderId) {
        // any pool of two listed tokens (registered here if new): their Chainlink prices guard every run
        uint24 poolIndex = rules.registerPool(p.key);
        if (
            p.liquidity == 0 || p.tickLower >= p.tickUpper || p.expiry <= block.timestamp
                || p.keeperFeeBps > MAX_KEEPER_FEE_BPS
        ) revert InvalidOrder();
        if (!p.key.currency0.isAddressZero() && msg.value != 0) revert BadMsgValue();

        orderId = nextOrderId++;
        (uint256 lo, uint256 up) = (p.lower, p.upper);
        OrderState.State memory st = _decodeWords(lo, up);
        _checkPlan(p, poolIndex, orderId, lo, up);
        rules.checkSide(lo, false, poolIndex, OrderState.LEG_RANGE, p.away.kind != 0);
        rules.checkSide(up, true, poolIndex, OrderState.LEG_RANGE, p.away.kind != 0);
        if (_bothOff(st)) revert InvalidOrder();

        _start(poolIndex, st, p.tickLower, p.tickUpper);
        (lo, up) = _encode(st);

        _ordersOf[msg.sender].push(orderId);
        _orders[orderId] = Order({
            owner: msg.sender,
            poolIndex: poolIndex,
            expiry: p.expiry,
            keeperFeeBps: p.keeperFeeBps,
            maxSlippage: p.maxSlippage,
            lowerState: lo,
            upperState: up
        });

        bytes memory res = poolManager.unlock(
            abi.encode(Op.Create, orderId, abi.encode(p.liquidity, p.amount0Max, p.amount1Max, msg.sender))
        );
        (uint256 paid0,) = abi.decode(res, (uint256, uint256));

        // native ETH is paid from this contract's balance, which also holds other owners' ETH: only msg.value may pay
        if (p.key.currency0.isAddressZero() && paid0 > msg.value) revert BadMsgValue();
        if (p.key.currency0.isAddressZero() && msg.value > paid0) {
            (bool ok,) = msg.sender.call{value: msg.value - paid0}("");
            if (!ok) revert RefundFailed();
        }

        emit OrderCreated(orderId, msg.sender, poolIndex, p.expiry, p.keeperFeeBps, p.maxSlippage, lo, up);
    }

    /// @notice Change the rule of the live leg of an open order (owner only). The position, the other leg, and the
    /// time each side last ran stay as they are. To stop the order completely, use `cancel`.
    function updateOrder(uint256 orderId, UpdateParams calldata p) external {
        Order storage o = _orders[orderId];
        if (o.owner == address(0)) revert UnknownOrder();
        if (msg.sender != o.owner) revert NotOwner();
        if (p.expiry <= block.timestamp || p.keeperFeeBps > MAX_KEEPER_FEE_BPS) revert InvalidOrder();

        (uint256 lo, uint256 up) = (p.lower, p.upper);
        OrderState.State memory st = _decodeWords(lo, up);
        if (_bothOff(st)) revert InvalidOrder();
        Plan storage plan = _plans[orderId];
        bool twoLegs = plan.here.kind != 0;
        uint8 kind = twoLegs ? plan.here.kind : OrderState.LEG_RANGE;
        rules.checkSide(lo, false, o.poolIndex, kind, twoLegs);
        rules.checkSide(up, true, o.poolIndex, kind, twoLegs);
        if (twoLegs) {
            rules.checkLegs(o.poolIndex, plan.there, [lo, up, plan.thereLower, plan.thereUpper]);
            if (!_moves(lo) && !_moves(up)) revert InvalidOrder(); // the leg must keep a way to the other one
        }

        OrderState.State memory current = _decode(o);
        st.lower.edge = current.lower.edge;
        st.upper.edge = current.upper.edge;
        st.lower.lastRun = current.lower.lastRun;
        st.upper.lastRun = current.upper.lastRun;
        _startTrail(o.poolIndex, st.lower);
        _startTrail(o.poolIndex, st.upper);
        (lo, up) = _encode(st);

        o.expiry = p.expiry;
        o.keeperFeeBps = p.keeperFeeBps;
        o.maxSlippage = p.maxSlippage;
        o.lowerState = lo;
        o.upperState = up;
        delete _armed[orderId]; // new sides: holds start again
        emit OrderUpdated(orderId, lo, up);
    }

    /// @notice Run one side of an order. Anyone can call; the condition is checked here.
    function execute(uint256 orderId, bool upper) external {
        Order storage o = _orders[orderId];
        if (o.owner == address(0)) revert UnknownOrder();
        if (block.timestamp > o.expiry) revert Expired();
        poolManager.unlock(abi.encode(Op.Execute, orderId, abi.encode(upper, msg.sender)));
    }

    /// @notice Keep a side's memory up to date. Anyone can call; it moves no tokens. Keepers call it as the price moves:
    ///  - a trailing side remembers the best price (the lower side the highest, the upper side the lowest);
    ///  - a side with a hold remembers when its condition was first seen true, and forgets it once it is not.
    function poke(uint256 orderId, bool upper) external {
        Order storage o = _orders[orderId];
        if (o.owner == address(0)) revert UnknownOrder();
        if (block.timestamp > o.expiry) revert Expired();
        uint256 word = upper ? o.upperState : o.lowerState;
        OrderState.Side memory sd = OrderState.decodeSide(word);
        bool changed;
        (bool trails, bool ok, int24 t) = rules.trailTick(o.poolIndex, word);
        if (trails && ok && (upper ? t < sd.best : t > sd.best)) {
            sd.best = t;
            word = OrderState.encodeSide(sd);
            if (upper) o.upperState = word;
            else o.lowerState = word;
            changed = true;
        }
        if (sd.holdMinutes != 0) {
            bool isMet = rules.met(address(this), orderId, o.poolIndex, o.lowerState, o.upperState, upper);
            uint32 armed = armedAt(orderId, upper);
            // a hold starts only when the pool and Chainlink both say the condition is true, so a push cannot start
            // one. It is forgotten when the condition stops at a price near Chainlink: a push can at most make it
            // start again (a step later, never earlier); a push far from Chainlink (or no Chainlink price) does nothing.
            (bool near,) = rules.tickOf(o.poolIndex);
            if (isMet == (armed == 0) && (isMet || near)) {
                _setArmed(orderId, upper, isMet ? uint32(block.timestamp) : 0);
                changed = true;
            }
        }
        if (!changed) revert NothingToPoke();
        emit OrderPoked(orderId, upper, word);
    }

    /// @notice When a side's condition was first seen true (0 = not now): its hold counts from then.
    function armedAt(uint256 orderId, bool upper) public view returns (uint32) {
        return uint32(_armed[orderId] >> (upper ? 32 : 0));
    }

    function _setArmed(uint256 orderId, bool upper, uint32 t) internal {
        uint64 a = _armed[orderId];
        _armed[orderId] = upper ? (a & 0xFFFFFFFF) | (uint64(t) << 32) : (a & ~uint64(0xFFFFFFFF)) | uint64(t);
    }

    /// @notice Close the order and send all tokens to the owner. The owner can do this at any time,
    /// anyone else only after expiry.
    function cancel(uint256 orderId) external {
        Order storage o = _orders[orderId];
        if (o.owner == address(0)) revert UnknownOrder();
        if (msg.sender != o.owner && block.timestamp <= o.expiry) revert NotOwner();
        poolManager.unlock(abi.encode(Op.Cancel, orderId, bytes("")));
    }

    /// @notice Send payouts that could not be delivered earlier to any address.
    function withdraw(Currency currency, address to) external returns (uint256 amount) {
        amount = owed[msg.sender][currency];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender][currency] = 0;
        currency.transfer(to, amount);
        emit Withdrawn(msg.sender, currency, to, amount);
    }

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    /// @notice The order. Its sides are packed words: Rules.decode unpacks one.
    function getOrder(uint256 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    /// @notice The second leg of a two-leg strategy (here.kind = 0 for a one-leg order).
    function getPlan(uint256 orderId) external view returns (Plan memory) {
        return _plans[orderId];
    }

    /// @notice Every order id `owner` created. Closed orders are included; `getOrder` returns a zero owner for them.
    function ordersOf(address owner) external view returns (uint256[] memory) {
        return _ordersOf[owner];
    }

    // ---------------------------------------------------------------
    // Unlock callback
    // ---------------------------------------------------------------

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (Op op, uint256 orderId, bytes memory args) = abi.decode(data, (Op, uint256, bytes));
        if (op == Op.Create) return _create(orderId, args);
        if (op == Op.Execute) {
            (bool upper, address keeper) = abi.decode(args, (bool, address));
            _execute(orderId, upper, keeper);
        } else {
            Order memory o = _orders[orderId];
            PoolKey memory key = _key(o.poolIndex);
            _close(key, _decode(o), orderId);
            _payOut(key, o.owner);
        }
        return "";
    }

    function _create(uint256 orderId, bytes memory args) internal returns (bytes memory) {
        (uint128 liquidity, uint128 max0, uint128 max1, address payer) =
            abi.decode(args, (uint128, uint128, uint128, address));
        Order storage o = _orders[orderId];
        OrderState.State memory st = _decode(o);
        PoolKey memory key = _key(o.poolIndex);

        (BalanceDelta d,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: st.lower.edge,
                tickUpper: st.upper.edge,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(orderId)
            }),
            ""
        );
        uint256 pay0 = _neg(d.amount0());
        uint256 pay1 = _neg(d.amount1());
        if (pay0 > max0 || pay1 > max1) revert TooMuchIn();

        key.currency0.settle(poolManager, key.currency0.isAddressZero() ? address(this) : payer, pay0, false);
        key.currency1.settle(poolManager, payer, pay1, false);
        return abi.encode(pay0, pay1);
    }

    // ---------------------------------------------------------------
    // Execution
    // ---------------------------------------------------------------

    function _execute(uint256 orderId, bool upper, address keeper) internal {
        Run memory r;
        r.orderId = orderId;
        r.upper = upper;
        r.keeper = keeper;
        r.order = _orders[orderId];
        r.st = _decode(r.order);
        r.key = _key(r.order.poolIndex);
        r.to = r.key;
        r.salt = bytes32(orderId);

        OrderState.Side memory sd = upper ? r.st.upper : r.st.lower; // a reference into r.st
        if (sd.checker == OrderState.CHECK_OFF) revert SideOff();
        if (block.timestamp < uint256(sd.lastRun) + MIN_GAP) revert TooSoon();
        if (!rules.met(address(this), orderId, r.order.poolIndex, r.order.lowerState, r.order.upperState, upper)) {
            revert ConditionNotMet();
        }
        if (sd.holdMinutes != 0) {
            uint32 armed = armedAt(orderId, upper);
            if (armed == 0 || block.timestamp < uint256(armed) + uint256(sd.holdMinutes) * 60) {
                revert NotHeldLongEnough();
            }
            _setArmed(orderId, upper, 0); // a repeating side waits its hold again
        }
        // runs swap and deposit at the price of the moment: only while it is near Chainlink
        rules.checkPrice(r.key);
        if (sd.actions & OrderState.ACT_MOVE != 0) return _move(r, sd);

        _removeAndReserve(r, sd);
        if (sd.actions & OrderState.ACT_SWAP != 0) _instantSwap(r, sd);
        if (sd.actions & OrderState.ACT_ADD != 0) _add(r, sd);

        // Update the side that ran.
        sd.lastRun = uint32(block.timestamp);
        bool again = sd.repeat;
        if (again && sd.runsLeft != 0) {
            sd.runsLeft -= 1; // a limited side switches off after its last run
            again = sd.runsLeft != 0;
        }
        if (again) {
            _startTrail(r.order.poolIndex, sd); // a trailing stop starts again from the price after this run
            // a repeating price level moves by `shape` (a re-centring side keeps its widths there, and has no level)
            if (sd.actions & OrderState.ACT_ADD == 0 || sd.addMode != OrderState.ADD_CENTERED) {
                int256 step = upper ? int256(uint256(sd.shape)) : -int256(uint256(sd.shape));
                if (_isLevel(sd.checker)) sd.value = _clampTick(int256(sd.value) + step);
                if (sd.combine != OrderState.COMBINE_NONE && _isLevel(sd.checker2)) {
                    sd.value2 = _clampTick(int256(sd.value2) + step);
                }
            }
        } else {
            sd.clear();
        }

        // Everything except the final transfers happens before the keeper's gas is measured: closing the position
        // and the storage writes. `_settle` then pays the keeper and the owner.
        uint128 left = _positionLiquidity(r.key, r.st.lower.edge, r.st.upper.edge, r.salt);
        if (left == 0 || _bothOff(r.st)) {
            _close(r.key, r.st, orderId);
        } else {
            (uint256 lo, uint256 up) = _encode(r.st);
            Order storage o = _orders[orderId];
            o.lowerState = lo;
            o.upperState = up;
            emit OrderExecuted(orderId, upper, keeper, lo, up);
        }
        _settle(r);
    }

    /// @dev A move: take everything out of the live leg, swap first if the side says so, and put it into the other
    /// leg, which becomes the live one. The leg that is left keeps its sides for the way back.
    function _move(Run memory r, OrderState.Side memory sd) internal {
        Plan storage plan = _plans[r.orderId];
        OrderState.Leg memory left = plan.here;
        OrderState.Leg memory to = plan.there;

        // 1. take everything out
        if (left.kind == OrderState.LEG_IDLE) _release(r, plan);
        else _removeAndReserve(r, sd);
        if (sd.actions & OrderState.ACT_SWAP != 0) _instantSwap(r, sd);

        // 2. book the run on the side that fired; it waits with its leg for the way back
        sd.lastRun = uint32(block.timestamp);
        if (sd.runsLeft != 0 && --sd.runsLeft == 0) sd.clear();
        (uint256 leftLower, uint256 leftUpper) = _encode(r.st);
        OrderState.State memory next;
        next.lower = OrderState.decodeSide(plan.thereLower);
        next.upper = OrderState.decodeSide(plan.thereUpper);
        delete _armed[r.orderId]; // the other leg's sides start fresh
        plan.here = to;
        plan.there = left;
        plan.thereLower = leftLower;
        plan.thereUpper = leftUpper;

        // 3. enter the other leg
        r.to = _key(to.poolIndex);
        (int24 tickLower, int24 tickUpper) = _enter(r, plan, to);
        // a range entered with nothing (its swap stopped at the slippage limit at once): the move waits and is tried
        // again later
        if (to.kind != OrderState.LEG_IDLE && _positionLiquidity(r.to, tickLower, tickUpper, r.salt) == 0) {
            revert NothingToEnter();
        }
        _start(to.poolIndex, next, tickLower, tickUpper);
        (uint256 lo, uint256 up) = _encode(next);
        Order storage o = _orders[r.orderId];
        o.poolIndex = to.poolIndex;
        o.lowerState = lo;
        o.upperState = up;
        emit OrderMoved(r.orderId, r.upper, r.keeper, to.poolIndex, to.kind, lo, up);
        // a leg whose sides have all used up their runs can never move again: the order ends there
        if (_bothOff(next)) _close(r.to, next, r.orderId);
        _settle(r);
    }

    /// @dev Put the working tokens (r.w0, r.w1, in r.key's pair) into leg `to`. Returns its range (0, 0 when
    /// waiting). A token the new pool does not have stays a credit and is paid to the owner (Rules.checkLegs makes
    /// the move swap it away first, so this is only what a swap limit left unsold).
    function _enter(Run memory r, Plan storage plan, OrderState.Leg memory to)
        internal
        returns (int24 tickLower, int24 tickUpper)
    {
        if (to.kind == OrderState.LEG_IDLE) {
            // a waiting leg is in the same pair: hold the tokens for the order as claims inside the PoolManager
            if (r.w0 > 0) poolManager.mint(address(this), r.key.currency0.toId(), r.w0);
            if (r.w1 > 0) poolManager.mint(address(this), r.key.currency1.toId(), r.w1);
            plan.held0 = uint128(r.w0);
            plan.held1 = uint128(r.w1);
            return (0, 0);
        }
        PoolKey memory k = r.to;
        if (to.poolIndex != r.order.poolIndex) rules.checkPrice(k); // the pool it goes into
        uint256 h0 = _amountOf(r, k.currency0);
        uint256 h1 = _amountOf(r, k.currency1);
        (tickLower, tickUpper) = rules.rangeOf(k, to);
        (h0, h1) = _zapSwap(r, k, tickLower, tickUpper, h0, h1);
        uint128 liq = rules.liquidityFor(k, tickLower, tickUpper, h0, h1);
        if (liq > 0) {
            poolManager.modifyLiquidity(
                k,
                ModifyLiquidityParams({
                    tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: int256(uint256(liq)), salt: r.salt
                }),
                ""
            );
        }
    }

    /// @dev Swap holdings (h0, h1) of pool k to the mix the range needs (Rules.mixFor), never more than maxSlippage
    /// past the price before it. Returns the holdings after the swap.
    function _zapSwap(Run memory r, PoolKey memory k, int24 tickLower, int24 tickUpper, uint256 h0, uint256 h1)
        internal
        returns (uint256, uint256)
    {
        (bool zeroForOne, uint256 amountIn, uint160 stopAt) = rules.mixFor(k, tickLower, tickUpper, h0, h1);
        if (amountIn == 0) return (h0, h1);
        uint160 limit = rules.swapLimit(k, zeroForOne, r.order.maxSlippage);
        if (stopAt != 0 && (zeroForOne ? stopAt > limit : stopAt < limit)) limit = stopAt;
        (uint256 spent, uint256 got) = _swap(k, zeroForOne, amountIn, limit);
        return zeroForOne ? (h0 - spent, h1 + got) : (h0 + got, h1 - spent);
    }

    /// @dev Remove (or just collect), set the keeper's ceiling aside, and set aside the fees the owner does not want
    /// reinvested. Everything set aside stays as a credit in this unlock and is paid out at the end.
    function _removeAndReserve(Run memory r, OrderState.Side memory sd) internal {
        uint128 liq = _positionLiquidity(r.key, r.st.lower.edge, r.st.upper.edge, r.salt);
        uint128 removeLiq = sd.actions & OrderState.ACT_REMOVE != 0 ? uint128((uint256(liq) * sd.removeBps) / BPS) : 0;

        (BalanceDelta out, BalanceDelta fees) = poolManager.modifyLiquidity(
            r.key,
            ModifyLiquidityParams({
                tickLower: r.st.lower.edge,
                tickUpper: r.st.upper.edge,
                liquidityDelta: -int256(uint256(removeLiq)),
                salt: r.salt
            }),
            ""
        );
        _reserve(r, sd, _pos(out.amount0()), _pos(out.amount1()));
        if (sd.actions & OrderState.ACT_KEEP_FEES == 0) {
            uint256 f0 = _pos(fees.amount0());
            uint256 f1 = _pos(fees.amount1());
            r.w0 -= f0 > r.w0 ? r.w0 : f0;
            r.w1 -= f1 > r.w1 ? r.w1 : f1;
        }
    }

    /// @dev Leaving a waiting leg: turn the held claims back into a credit, and set the keeper's fee aside.
    function _release(Run memory r, Plan storage plan) internal {
        uint256 held0 = plan.held0;
        uint256 held1 = plan.held1;
        _burnHeld(r.key, plan);
        _reserve(r, OrderState.decodeSide(0), held0, held1);
    }

    /// @dev Set the keeper's fee aside from what a run took out; the rest is what the actions may use. A run that
    /// swaps pays the keeper after the swap, out of what the swap produced (see _instantSwap).
    function _reserve(Run memory r, OrderState.Side memory sd, uint256 out0, uint256 out1) internal pure {
        r.reserve0 = (out0 * r.order.keeperFeeBps) / BPS;
        r.reserve1 = (out1 * r.order.keeperFeeBps) / BPS;
        if (sd.actions & OrderState.ACT_SWAP != 0) {
            if (sd.swapToToken1) r.reserve0 = 0;
            else r.reserve1 = 0;
        }
        r.w0 = out0 - r.reserve0;
        r.w1 = out1 - r.reserve1;
    }

    /// @dev The last step of a run: pay the keeper its fee, then send everything else this contract is owed to the
    /// owner.
    function _settle(Run memory r) internal {
        uint256 c0 = _credit(r.key.currency0);
        uint256 c1 = _credit(r.key.currency1);
        uint256 pay0 = r.reserve0 < c0 ? r.reserve0 : c0;
        uint256 pay1 = r.reserve1 < c1 ? r.reserve1 : c1;
        r.key.currency0.take(poolManager, r.keeper, pay0, false);
        r.key.currency1.take(poolManager, r.keeper, pay1, false);
        if (c0 > pay0) _send(r.key.currency0, r.order.owner, c0 - pay0);
        if (c1 > pay1) _send(r.key.currency1, r.order.owner, c1 - pay1);
        _payOut(r.to, r.order.owner); // a move into another pair may leave a little of its tokens
    }

    function _credit(Currency currency) internal view returns (uint256) {
        int256 d = poolManager.currencyDelta(address(this), currency);
        return d > 0 ? uint256(d) : 0;
    }

    /// @dev Swap everything of one token into the other in the order's pool, stopping maxSlippage past the price
    /// before it. Whatever that limit leaves unsold goes to the owner as it is. The keeper's fee for this run is then
    /// taken from what the swap left: the bought amount, plus anything that stayed unsold.
    function _instantSwap(Run memory r, OrderState.Side memory sd) internal {
        bool zeroForOne = sd.swapToToken1;
        uint256 amountIn = zeroForOne ? r.w0 : r.w1;
        if (amountIn == 0) return;

        (uint256 spent, uint256 got) =
            _swap(r.key, zeroForOne, amountIn, rules.swapLimit(r.key, zeroForOne, r.order.maxSlippage));
        uint256 fee = r.order.keeperFeeBps;
        uint256 unsold = amountIn - spent;
        uint256 bought = got - (got * fee) / BPS;
        if (zeroForOne) {
            (r.reserve0, r.reserve1) = ((unsold * fee) / BPS, r.reserve1 + (got * fee) / BPS);
            (r.w0, r.w1) = (unsold - (unsold * fee) / BPS, r.w1 + bought);
        } else {
            (r.reserve1, r.reserve0) = ((unsold * fee) / BPS, r.reserve0 + (got * fee) / BPS);
            (r.w1, r.w0) = (unsold - (unsold * fee) / BPS, r.w0 + bought);
        }
    }

    /// @dev Exact-input swap that stops at `limit`. Skipped when the price is already past it.
    function _swap(PoolKey memory k, bool zeroForOne, uint256 amountIn, uint160 limit)
        internal
        returns (uint256 spent, uint256 got)
    {
        (uint160 current,,,) = poolManager.getSlot0(k.toId());
        if (zeroForOne ? limit >= current : limit <= current) return (0, 0);
        BalanceDelta d = poolManager.swap(
            k, SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: limit}), ""
        );
        spent = _neg(zeroForOne ? d.amount0() : d.amount1());
        got = _pos(zeroForOne ? d.amount1() : d.amount0());
    }

    /// @dev Add the working tokens back: into the same range, or into a new range around the price (re-centre),
    /// swapped to the mix that range needs first, the same way a move enters a range.
    function _add(Run memory r, OrderState.Side memory sd) internal {
        int24 lower = r.st.lower.edge;
        int24 upper = r.st.upper.edge;
        uint256 a0 = r.w0;
        uint256 a1 = r.w1;

        if (sd.addMode == OrderState.ADD_CENTERED) {
            (lower, upper) = rules.centeredRange(r.key, sd.widthBelow(), sd.widthAbove());
            (a0, a1) = _zapSwap(r, r.key, lower, upper, a0, a1);
        }

        uint128 liq = rules.liquidityFor(r.key, lower, upper, a0, a1);
        if (liq == 0) return;
        poolManager.modifyLiquidity(
            r.key,
            ModifyLiquidityParams({
                tickLower: lower, tickUpper: upper, liquidityDelta: int256(uint256(liq)), salt: r.salt
            }),
            ""
        );
        r.st.lower.edge = lower;
        r.st.upper.edge = upper;
    }

    /// @dev End the order: take out whatever its position or held tokens still have (they stay a credit in this
    /// unlock) and delete it.
    function _close(PoolKey memory key, OrderState.State memory st, uint256 orderId) internal {
        Plan storage plan = _plans[orderId];
        if (plan.here.kind == OrderState.LEG_IDLE) {
            _burnHeld(key, plan);
        } else {
            uint128 liq = _positionLiquidity(key, st.lower.edge, st.upper.edge, bytes32(orderId));
            if (liq > 0) {
                poolManager.modifyLiquidity(
                    key,
                    ModifyLiquidityParams({
                        tickLower: st.lower.edge,
                        tickUpper: st.upper.edge,
                        liquidityDelta: -int256(uint256(liq)),
                        salt: bytes32(orderId)
                    }),
                    ""
                );
            }
        }
        delete _orders[orderId];
        delete _plans[orderId];
        emit OrderClosed(orderId);
    }

    /// @dev Burn the claims held for a waiting order: they become a credit in this unlock.
    function _burnHeld(PoolKey memory key, Plan storage plan) internal {
        if (plan.held0 > 0) poolManager.burn(address(this), key.currency0.toId(), plan.held0);
        if (plan.held1 > 0) poolManager.burn(address(this), key.currency1.toId(), plan.held1);
        plan.held0 = 0;
        plan.held1 = 0;
    }

    /// @dev Send whatever this contract is owed in the current unlock in `key`'s two tokens to `to`.
    function _payOut(PoolKey memory key, address to) internal {
        uint256 c0 = _credit(key.currency0);
        uint256 c1 = _credit(key.currency1);
        if (c0 > 0) _send(key.currency0, to, c0);
        if (c1 > 0) _send(key.currency1, to, c1);
    }

    /// @dev Pay `to` out of this contract's credit, without ever blocking the order. A token goes straight from the
    /// PoolManager to `to`; if that transfer fails (a blacklisted address, say) the tokens are taken here and kept
    /// as `owed`. ETH is taken here first and sent on with a gas limit, so a receiving contract cannot use up the
    /// keeper's gas; if it refuses the ETH, that is kept as `owed` too.
    function _send(Currency currency, address to, uint256 amount) internal {
        if (!currency.isAddressZero()) {
            try poolManager.take(currency, to, amount) {
                return;
            } catch {}
        }
        currency.take(poolManager, address(this), amount, false);
        if (currency.isAddressZero()) {
            uint256 g = PAYOUT_GAS;
            bool ok;
            assembly ("memory-safe") {
                ok := call(g, to, amount, 0, 0, 0, 0)
            }
            if (ok) return;
        }
        owed[to][currency] += amount;
        emit PayoutHeld(to, currency, amount);
    }

    // ---------------------------------------------------------------
    // Strategy setup
    // ---------------------------------------------------------------

    /// @dev Check and store the second leg of a two-leg strategy.
    function _checkPlan(CreateParams calldata p, uint24 poolIndex, uint256 orderId, uint256 lo, uint256 up) internal {
        (uint256 awayLo, uint256 awayUp) = (p.awayLower, p.awayUpper);
        if (p.away.kind == 0) {
            if (
                p.home.kind != 0 || p.home.a != 0 || p.home.b != 0 || p.home.poolIndex != 0 || p.away.poolIndex != 0
                    || p.away.a != 0 || p.away.b != 0 || awayLo != 0 || awayUp != 0
            ) revert InvalidOrder();
            return;
        }
        // the home leg is this order's position: its pool is named by the order itself, so the field must be 0
        if (p.home.poolIndex != 0) revert InvalidOrder();
        OrderState.Leg memory home = p.home;
        home.poolIndex = poolIndex;
        if (home.kind == OrderState.LEG_RANGE) {
            if (home.a != p.tickLower || home.b != p.tickUpper) revert InvalidOrder();
        } else if (home.kind == OrderState.LEG_CENTERED) {
            rules.checkRange(home, p.key.tickSpacing);
        } else {
            revert InvalidOrder();
        }
        // the move sides of each leg, and that each leg can move to the other
        rules.checkLegs(poolIndex, p.away, [lo, up, awayLo, awayUp]);
        rules.checkLegs(p.away.poolIndex, home, [awayLo, awayUp, lo, up]);
        rules.checkSide(awayLo, false, p.away.poolIndex, p.away.kind, true);
        rules.checkSide(awayUp, true, p.away.poolIndex, p.away.kind, true);
        if (!_moves(lo) && !_moves(up)) revert InvalidOrder();
        if (!_moves(awayLo) && !_moves(awayUp)) revert InvalidOrder();

        Plan storage plan = _plans[orderId];
        plan.here = home;
        plan.there = p.away;
        plan.thereLower = awayLo;
        plan.thereUpper = awayUp;
    }

    /// @dev Start a leg's sides: its range, the time they start from, and trailing prices.
    function _start(uint24 poolIndex, OrderState.State memory st, int24 tickLower, int24 tickUpper) internal view {
        st.lower.edge = tickLower;
        st.upper.edge = tickUpper;
        st.lower.lastRun = uint32(block.timestamp);
        st.upper.lastRun = uint32(block.timestamp);
        _startTrail(poolIndex, st.lower);
        _startTrail(poolIndex, st.upper);
    }

    /// @dev Start a trailing condition from the current price of the pool it reads (it must be near Chainlink).
    function _startTrail(uint24 poolIndex, OrderState.Side memory sd) internal view {
        sd.best = 0;
        (bool trails, bool ok, int24 t) = rules.trailTick(poolIndex, OrderState.encodeSide(sd));
        if (!trails) return;
        if (!ok) revert NoPrice();
        sd.best = t;
    }

    function _moves(uint256 word) internal pure returns (bool) {
        return OrderState.decodeSide(word).actions & OrderState.ACT_MOVE != 0;
    }

    // ---------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------

    /// @dev Working tokens of the run in `currency` (zero for a token outside the run's first pair).
    function _amountOf(Run memory r, Currency currency) internal pure returns (uint256) {
        if (currency == r.key.currency0) return r.w0;
        if (currency == r.key.currency1) return r.w1;
        return 0;
    }

    function _inPair(Currency currency, PoolKey memory key) internal pure returns (bool) {
        return currency == key.currency0 || currency == key.currency1;
    }

    function _bothOff(OrderState.State memory st) internal pure returns (bool) {
        return st.lower.checker == OrderState.CHECK_OFF && st.upper.checker == OrderState.CHECK_OFF;
    }

    function _isLevel(uint8 checker) internal pure returns (bool) {
        return checker == OrderState.CHECK_TICK;
    }

    function _positionLiquidity(PoolKey memory key, int24 tickLower, int24 tickUpper, bytes32 salt)
        internal
        view
        returns (uint128)
    {
        bytes32 positionId = Position.calculatePositionKey(address(this), tickLower, tickUpper, salt);
        return poolManager.getPositionLiquidity(key.toId(), positionId);
    }

    function _decode(Order memory o) internal pure returns (OrderState.State memory) {
        return _decodeWords(o.lowerState, o.upperState);
    }

    function _decodeWords(uint256 lo, uint256 up) internal pure returns (OrderState.State memory st) {
        st.lower = OrderState.decodeSide(lo);
        st.upper = OrderState.decodeSide(up);
    }

    function _encode(OrderState.State memory st) internal pure returns (uint256 lo, uint256 up) {
        lo = OrderState.encodeSide(st.lower);
        up = OrderState.encodeSide(st.upper);
    }

    function _key(uint24 index) internal view returns (PoolKey memory) {
        return rules.poolKeyAt(index);
    }

    function _clampTick(int256 t) internal pure returns (int24) {
        if (t <= TickMath.MIN_TICK) return TickMath.MIN_TICK + 1;
        if (t >= TickMath.MAX_TICK) return TickMath.MAX_TICK - 1;
        return int24(t);
    }

    function _pos(int128 x) internal pure returns (uint256) {
        return x > 0 ? uint256(uint128(x)) : 0;
    }

    function _neg(int128 x) internal pure returns (uint256) {
        return x < 0 ? uint256(uint128(-x)) : 0;
    }
}
