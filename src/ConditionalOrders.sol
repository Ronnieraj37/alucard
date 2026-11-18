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
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {OrderState} from "./libraries/OrderState.sol";
import {RuleHook} from "./RuleHook.sol";
import {PriceFeeds} from "./PriceFeeds.sol";

/// @title ConditionalOrders: LP positions with a rule, run by keepers
/// @notice An LP adds liquidity through this contract together with a rule. This contract owns the position in the
/// PoolManager (owner = this contract, salt = orderId). Positions live in pools that use RuleHook. Anyone may call `execute`; the contract re-checks the rule's
/// condition on-chain, runs the actions (remove, swap, add), pays the caller a capped fee out of the removed tokens
/// and sends everything else to the owner. The owner can cancel at any time.
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
    error PoolNotAllowed();
    error UnknownPool();
    error CurrencyMismatch();
    error InvalidOrder();
    error InvalidSide();
    error NotOwner();
    error UnknownOrder();
    error Expired();
    error SideOff();
    error ConditionNotMet();
    error WouldRefire();
    error SwappedThisTx();
    error NotHeld();
    error NothingToPoke();
    error TooMuchIn();
    error BadMsgValue();
    error RefundFailed();
    error NothingOwed();
    error TokenNotAllowed();
    error OrderTooSmall();
    error OnlySelf();
    error BatchOutOfGas();

    uint256 internal constant BPS = 10_000;
    uint8 public constant MAX_KEEPER_FEE_BPS = 100;

    /// @dev Keeper pay = measured gas x gas price x a premium, taken from the order's removed tokens and never more
    /// than maxKeeperFeeBps of them. The gas is measured up to the final transfers. What the measurement cannot see
    /// is added as fixed amounts: KEEPER_GAS_OVERHEAD for the transaction's base cost, its calldata, the call into
    /// the PoolManager and the keeper's own transfer, and TRANSFER_GAS for each token sent to the owner. Both were
    /// fitted to real runs (test_pay_tracksRealGasAcrossRuleKinds). The gas price counted is capped so a keeper
    /// cannot inflate it. The premium is 110% for the part paid in ETH and 120% for the part paid in a token, which
    /// the keeper still has to sell for ETH. Token amounts come from the Chainlink feeds in `feeds`.
    uint256 public constant KEEPER_GAS_OVERHEAD = 36_000;
    uint256 public constant KEEPER_PREMIUM_BPS = 11_000;
    uint256 public constant KEEPER_TOKEN_PREMIUM_BPS = 12_000;
    /// @dev In `executeMany` the orders share one KEEPER_GAS_OVERHEAD, and each adds these smaller amounts: after the
    /// first order the tokens and accounts are already loaded in the transaction, so its transfers cost less.
    uint256 public constant BATCH_ORDER_GAS = 6_000;
    uint256 public constant BATCH_TRANSFER_GAS = 8_000;
    /// @dev Gas counted for each token sent to the owner after the measurement.
    uint256 public constant TRANSFER_GAS = 20_000;
    uint256 public constant MAX_PRIORITY_FEE_WEI = 0.01 gwei;
    /// @dev Gas given to the owner's address when sending it ETH, so a receiving contract cannot use up the keeper's gas.
    uint256 public constant PAYOUT_GAS = 100_000;

    /// @dev Three storage slots per order.
    struct Order {
        // slot 0, written once (160 + 24 + 24 + 32 + 8 + 8 = 256 bits)
        address owner;
        uint24 poolIndex; // pool that holds the position
        uint24 swapPoolIndex; // pool used for instant swaps (same pair)
        uint32 expiry;
        uint8 maxKeeperFeeBps; // ceiling on the keeper's pay per run, in bps of the removed tokens
        uint8 maxSlippage; // instant swaps stop this far past the trigger price, in steps of 10 ticks (~0.1%)
        // slots 1 and 2, rewritten when the order runs: one OrderState word per side
        uint256 lowerState;
        uint256 upperState;
    }

    struct CreateParams {
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint128 amount0Max;
        uint128 amount1Max;
        uint24 swapPoolIndex; // 0 = swap in the order's own pool
        uint32 expiry;
        uint8 maxKeeperFeeBps;
        uint8 maxSlippage; // steps of 10 ticks
        OrderState.Side lower;
        OrderState.Side upper;
    }

    /// @dev New rule for an existing order. The position's range stays as it is.
    struct UpdateParams {
        uint24 swapPoolIndex; // 0 = the order's own pool
        uint32 expiry;
        uint8 maxKeeperFeeBps;
        uint8 maxSlippage;
        OrderState.Side lower;
        OrderState.Side upper;
    }

    enum Op {
        Create,
        Execute,
        Cancel,
        ExecuteMany
    }

    /// @dev Working data for one execution, kept in memory to avoid stack limits.
    struct Run {
        uint256 orderId;
        bool upper;
        address keeper;
        uint256 gasStart;
        uint256 overhead; // gas allowance for what the measurement cannot see
        uint256 transferGas; // gas allowance per token sent to the owner
        Order order;
        OrderState.State st;
        PoolKey key;
        bytes32 salt;
        uint256 w0; // tokens the actions may use
        uint256 w1;
        uint256 reserve0; // set aside for the keeper (the fee ceiling); the unused part goes to the owner
        uint256 reserve1;
    }

    IPoolManager public immutable poolManager;
    RuleHook public immutable hook; // holds the pool table
    PriceFeeds public immutable feeds; // the token list: Chainlink prices for keeper pay, order size and conditions

    uint256 public nextOrderId = 1;
    mapping(uint256 orderId => Order) internal _orders;
    /// @dev Every order id an address created (closed ones included; their owner reads as zero).
    mapping(address owner => uint256[] orderIds) internal _ordersOf;
    /// @notice Payouts that could not be sent, waiting for the owner to withdraw them.
    mapping(address owner => mapping(Currency currency => uint256 amount)) public owed;

    event OrderCreated(
        uint256 indexed orderId,
        address indexed owner,
        uint24 indexed poolIndex,
        uint24 swapPoolIndex,
        uint32 expiry,
        uint8 maxKeeperFeeBps,
        uint8 maxSlippage,
        uint256 lowerState,
        uint256 upperState
    );
    event OrderExecuted(
        uint256 indexed orderId, bool upper, address indexed keeper, uint256 lowerState, uint256 upperState
    );
    event OrderClosed(uint256 indexed orderId);
    event OrderUpdated(uint256 indexed orderId, uint256 lowerState, uint256 upperState);
    event OrderPoked(uint256 indexed orderId, bool upper, uint256 state);
    event PayoutHeld(address indexed owner, Currency indexed currency, uint256 amount);
    event Withdrawn(address indexed owner, Currency indexed currency, address to, uint256 amount);

    constructor(IPoolManager _poolManager, RuleHook _hook, PriceFeeds _feeds) {
        poolManager = _poolManager;
        hook = _hook;
        feeds = _feeds;
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

    /// @notice Add liquidity with a rule attached. Approve this contract for both tokens first (for native ETH as
    /// currency0, send it as msg.value; anything not used is refunded).
    function createOrder(CreateParams calldata p) external payable returns (uint256 orderId) {
        if (address(p.key.hooks) != address(hook)) revert PoolNotAllowed();
        uint24 poolIndex = hook.poolIndexOf(p.key.toId());
        if (poolIndex == 0) revert UnknownPool();
        // only pairs of listed tokens: each has a Chainlink price, so the keeper can be paid its gas in either one
        if (!feeds.isListed(Currency.unwrap(p.key.currency0)) || !feeds.isListed(Currency.unwrap(p.key.currency1))) {
            revert TokenNotAllowed();
        }
        uint24 swapIndex = p.swapPoolIndex == 0 ? poolIndex : p.swapPoolIndex;
        if (!_samePair(p.key, swapIndex)) revert CurrencyMismatch();

        if (
            p.liquidity == 0 || p.tickLower >= p.tickUpper || p.expiry <= block.timestamp
                || p.maxKeeperFeeBps > MAX_KEEPER_FEE_BPS
        ) revert InvalidOrder();
        if (p.lower.checker == OrderState.CHECK_OFF && p.upper.checker == OrderState.CHECK_OFF) revert InvalidOrder();
        _validateSide(p.lower, false, p.key.tickSpacing, poolIndex);
        _validateSide(p.upper, true, p.key.tickSpacing, poolIndex);
        if (!p.key.currency0.isAddressZero() && msg.value != 0) revert BadMsgValue();

        OrderState.State memory st;
        st.lower = p.lower;
        st.upper = p.upper;
        st.lower.edge = p.tickLower;
        st.upper.edge = p.tickUpper;
        st.lower.lastRun = uint32(block.timestamp);
        st.upper.lastRun = uint32(block.timestamp);
        _resetMemo(st.lower);
        _resetMemo(st.upper);
        _startTrail(p.key, st.lower);
        _startTrail(p.key, st.upper);
        (uint256 lo, uint256 up) = _encode(st);

        orderId = nextOrderId++;
        _ordersOf[msg.sender].push(orderId);
        _orders[orderId] = Order({
            owner: msg.sender,
            poolIndex: poolIndex,
            swapPoolIndex: swapIndex,
            expiry: p.expiry,
            maxKeeperFeeBps: p.maxKeeperFeeBps,
            maxSlippage: p.maxSlippage,
            lowerState: lo,
            upperState: up
        });

        bytes memory res = poolManager.unlock(
            abi.encode(Op.Create, orderId, abi.encode(p.liquidity, p.amount0Max, p.amount1Max, msg.sender))
        );
        (uint256 paid0, uint256 paid1) = abi.decode(res, (uint256, uint256));
        _checkOrderSize(p.key, paid0, paid1);

        if (p.key.currency0.isAddressZero() && msg.value > paid0) {
            (bool ok,) = msg.sender.call{value: msg.value - paid0}("");
            if (!ok) revert RefundFailed();
        }

        emit OrderCreated(orderId, msg.sender, poolIndex, swapIndex, p.expiry, p.maxKeeperFeeBps, p.maxSlippage, lo, up);
    }

    /// @notice Change the rule of an open order (owner only). The liquidity and its range stay as they are.
    /// Timers restart now. To stop the order completely, use `cancel`.
    function updateOrder(uint256 orderId, UpdateParams calldata p) external {
        Order storage o = _orders[orderId];
        if (o.owner == address(0)) revert UnknownOrder();
        if (msg.sender != o.owner) revert NotOwner();
        PoolKey memory key = _key(o.poolIndex);
        uint24 swapIndex = p.swapPoolIndex == 0 ? o.poolIndex : p.swapPoolIndex;
        if (!_samePair(key, swapIndex)) revert CurrencyMismatch();
        if (p.expiry <= block.timestamp || p.maxKeeperFeeBps > MAX_KEEPER_FEE_BPS) revert InvalidOrder();
        if (p.lower.checker == OrderState.CHECK_OFF && p.upper.checker == OrderState.CHECK_OFF) revert InvalidOrder();
        _validateSide(p.lower, false, key.tickSpacing, o.poolIndex);
        _validateSide(p.upper, true, key.tickSpacing, o.poolIndex);

        OrderState.State memory current = _decode(o);
        OrderState.State memory st;
        st.lower = p.lower;
        st.upper = p.upper;
        st.lower.edge = current.lower.edge;
        st.upper.edge = current.upper.edge;
        st.lower.lastRun = uint32(block.timestamp);
        st.upper.lastRun = uint32(block.timestamp);
        _resetMemo(st.lower);
        _resetMemo(st.upper);
        _startTrail(key, st.lower);
        _startTrail(key, st.upper);
        (uint256 lo, uint256 up) = _encode(st);

        o.swapPoolIndex = swapIndex;
        o.expiry = p.expiry;
        o.maxKeeperFeeBps = p.maxKeeperFeeBps;
        o.maxSlippage = p.maxSlippage;
        o.lowerState = lo;
        o.upperState = up;
        emit OrderUpdated(orderId, lo, up);
    }

    /// @notice Run one side of an order. Anyone can call; the condition is checked here.
    function execute(uint256 orderId, bool upper) external {
        Order storage o = _orders[orderId];
        if (o.owner == address(0)) revert UnknownOrder();
        if (block.timestamp > o.expiry) revert Expired();
        poolManager.unlock(abi.encode(Op.Execute, orderId, abi.encode(upper, msg.sender)));
    }

    /// @notice Run many sides in one transaction. An order that cannot run (condition not met, expired, closed) is
    /// skipped and the rest still run. Each order pays for its own measured gas; the cost every transaction pays
    /// once is shared between them, so a run costs its owner less than through `execute`.
    /// @return ran how many of them ran
    function executeMany(uint256[] calldata orderIds, bool[] calldata uppers) external returns (uint256 ran) {
        if (orderIds.length == 0 || orderIds.length != uppers.length) revert InvalidOrder();
        bytes memory res = poolManager.unlock(abi.encode(Op.ExecuteMany, 0, abi.encode(orderIds, uppers, msg.sender)));
        ran = abi.decode(res, (uint256));
    }

    /// @dev One order of `executeMany`, as a call to this contract so a failing order undoes only itself.
    function runOne(uint256 orderId, bool upper, address keeper, uint256 batchSize) external {
        if (msg.sender != address(this)) revert OnlySelf();
        uint256 gasStart = gasleft();
        Order storage o = _orders[orderId];
        if (o.owner == address(0)) revert UnknownOrder();
        if (block.timestamp > o.expiry) revert Expired();
        _execute(orderId, upper, keeper, gasStart, KEEPER_GAS_OVERHEAD / batchSize + BATCH_ORDER_GAS, BATCH_TRANSFER_GAS);
    }

    /// @notice Update what a side remembers between runs. Anyone can call; it moves no tokens.
    /// Hold: arms the side when its condition is true and it is not armed (or its arming has expired). Nobody can
    /// disarm, so nobody can keep resetting someone else's exit.
    /// Trailing stop: moves the remembered best price to the current price when it is better.
    function poke(uint256 orderId, bool upper) external {
        Order storage o = _orders[orderId];
        if (o.owner == address(0)) revert UnknownOrder();
        if (block.timestamp > o.expiry) revert Expired();
        OrderState.State memory st = _decode(o);
        OrderState.Side memory sd = upper ? st.upper : st.lower;
        if (sd.checker == OrderState.CHECK_OFF) revert SideOff();
        PoolKey memory key = _key(o.poolIndex);
        _checkSideNoSwap(key, sd);

        bool changed;
        if (sd.holdMinutes != 0) {
            bool expired = sd.armedAt == 0 || block.timestamp > uint256(sd.armedAt) + 2 * uint256(sd.holdMinutes) * 60;
            if (expired && _conditionMet(key, st, sd, upper)) {
                sd.armedAt = uint32(block.timestamp);
                changed = true;
            }
        }
        (bool trails, uint24 trailPool) = _trailPool(sd);
        if (trails) {
            int24 t = _tick(trailPool == 0 ? key : _key(trailPool));
            // lower side remembers the highest price seen, upper side the lowest
            if (upper ? t < sd.best : t > sd.best) {
                sd.best = t;
                changed = true;
            }
        }
        if (!changed) revert NothingToPoke();

        uint256 word = OrderState.encodeSide(sd);
        if (upper) o.upperState = word;
        else o.lowerState = word;
        emit OrderPoked(orderId, upper, word);
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

    function getOrder(uint256 orderId) external view returns (Order memory order, OrderState.State memory state) {
        order = _orders[orderId];
        state = _decode(order);
    }

    /// @notice Every order id `owner` created. Closed orders are included; `getOrder` returns a zero owner for them.
    function ordersOf(address owner) external view returns (uint256[] memory) {
        return _ordersOf[owner];
    }

    /// @notice Token amounts the order's position holds at the current price (fees not included).
    function orderAmounts(uint256 orderId) external view returns (uint256 amount0, uint256 amount1) {
        Order storage o = _orders[orderId];
        if (o.owner == address(0)) return (0, 0);
        OrderState.State memory st = _decode(o);
        PoolKey memory key = _key(o.poolIndex);
        uint128 liq = _positionLiquidity(key, st.lower.edge, st.upper.edge, bytes32(orderId));
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        uint160 a = TickMath.getSqrtPriceAtTick(st.lower.edge);
        uint160 b = TickMath.getSqrtPriceAtTick(st.upper.edge);
        if (sqrtPriceX96 <= a) {
            amount0 = SqrtPriceMath.getAmount0Delta(a, b, liq, false);
        } else if (sqrtPriceX96 >= b) {
            amount1 = SqrtPriceMath.getAmount1Delta(a, b, liq, false);
        } else {
            amount0 = SqrtPriceMath.getAmount0Delta(sqrtPriceX96, b, liq, false);
            amount1 = SqrtPriceMath.getAmount1Delta(a, sqrtPriceX96, liq, false);
        }
    }

    /// @notice Current price and active liquidity of a pool in the table.
    function poolState(uint24 poolIndex) external view returns (uint160 sqrtPriceX96, int24 tick, uint128 liquidity) {
        PoolId id = _key(poolIndex).toId();
        (sqrtPriceX96, tick,,) = poolManager.getSlot0(id);
        liquidity = poolManager.getLiquidity(id);
    }

    /// @notice Liquidity this contract holds for the order right now.
    function orderLiquidity(uint256 orderId) external view returns (uint128) {
        Order storage o = _orders[orderId];
        OrderState.State memory st = _decode(o);
        return _positionLiquidity(_key(o.poolIndex), st.lower.edge, st.upper.edge, bytes32(orderId));
    }

    /// @notice Whether `execute(orderId, upper)` would pass its condition check now (for keepers).
    function canExecute(uint256 orderId, bool upper) external view returns (bool) {
        Order storage o = _orders[orderId];
        if (o.owner == address(0) || block.timestamp > o.expiry) return false;
        OrderState.State memory st = _decode(o);
        OrderState.Side memory sd = upper ? st.upper : st.lower;
        if (sd.checker == OrderState.CHECK_OFF || !_held(sd)) return false;
        return _conditionMet(_key(o.poolIndex), st, sd, upper);
    }

    // ---------------------------------------------------------------
    // Unlock callback
    // ---------------------------------------------------------------

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        // Gas is measured inside this one call frame. Measuring across the call into the PoolManager would count
        // the 1/64 of gas the EVM holds back, which grows with the gas limit the keeper picks.
        uint256 gasStart = gasleft();
        (Op op, uint256 orderId, bytes memory args) = abi.decode(data, (Op, uint256, bytes));
        if (op == Op.Create) return _create(orderId, args);
        if (op == Op.Execute) {
            (bool upper, address keeper) = abi.decode(args, (bool, address));
            _execute(orderId, upper, keeper, gasStart, KEEPER_GAS_OVERHEAD, TRANSFER_GAS);
        } else if (op == Op.ExecuteMany) {
            (uint256[] memory ids, bool[] memory uppers, address keeper) =
                abi.decode(args, (uint256[], bool[], address));
            uint256 ran;
            for (uint256 i; i < ids.length; ++i) {
                uint256 given = gasleft();
                try this.runOne(ids[i], uppers[i], keeper, ids.length) {
                    ++ran;
                } catch {
                    // An order that ran out of gas must not look like one that could not run: a gas estimate only
                    // finds the gas for this transaction not to revert, and would settle on too little. A call that
                    // used up its gas leaves about 1/64 of it here.
                    if (gasleft() < given / 60) revert BatchOutOfGas();
                }
            }
            return abi.encode(ran);
        } else {
            _cancel(orderId);
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

    function _cancel(uint256 orderId) internal {
        Order memory o = _orders[orderId];
        OrderState.State memory st = _decode(o);
        PoolKey memory key = _key(o.poolIndex);
        _removeRest(key, st, orderId);
        delete _orders[orderId];
        emit OrderClosed(orderId);
        _payOut(key, o.owner);
    }

    // ---------------------------------------------------------------
    // Execution
    // ---------------------------------------------------------------

    function _execute(
        uint256 orderId,
        bool upper,
        address keeper,
        uint256 gasStart,
        uint256 overhead,
        uint256 transferGas
    ) internal {
        Run memory r;
        r.orderId = orderId;
        r.upper = upper;
        r.keeper = keeper;
        r.gasStart = gasStart;
        r.overhead = overhead;
        r.transferGas = transferGas;
        r.order = _orders[orderId];
        r.st = _decode(r.order);
        r.key = _key(r.order.poolIndex);
        r.salt = bytes32(orderId);

        OrderState.Side memory sd = upper ? r.st.upper : r.st.lower;
        if (sd.checker == OrderState.CHECK_OFF) revert SideOff();
        // No execution right after a swap in the same transaction: a flash-loaned price push followed by execute
        // (then a swap back) is the cheap way to force a trigger. Covers the order's pool and, for TICK, the
        // checked pool when it uses this hook (hookless pools are never flagged).
        _checkSideNoSwap(r.key, sd);
        if (!_conditionMet(r.key, r.st, sd, upper)) revert ConditionNotMet();
        if (!_held(sd)) revert NotHeld();
        int24 refTick = _refTick(r, sd); // read before the range can change

        _removeAndReserve(r, sd);
        if (sd.actions & OrderState.ACT_SWAP != 0) _instantSwap(r, sd, refTick);
        if (sd.actions & OrderState.ACT_ADD != 0) _add(r, sd);

        // Update the side that ran.
        sd.lastRun = uint32(block.timestamp);
        sd.armedAt = 0; // a hold starts again for the next run
        bool again_ = sd.repeat;
        if (again_ && sd.runsLeft != 0) {
            sd.runsLeft -= 1; // a limited side switches off after its last run
            again_ = sd.runsLeft != 0;
        }
        if (again_) {
            _startTrail(r.key, sd); // a trailing stop starts again from the price after this run
            // a repeating price level moves by `shape`, except when `shape` holds the widths of a one-sided re-range
            if (sd.actions & OrderState.ACT_ADD == 0 || sd.addMode != OrderState.ADD_ONE_SIDED) {
                int256 step = upper ? int256(uint256(sd.shape)) : -int256(uint256(sd.shape));
                if (_isLevel(sd.checker)) sd.value = _clampTick(int256(sd.value) + step);
                if (sd.combine != OrderState.COMBINE_NONE && _isLevel(sd.checker2)) {
                    sd.value2 = _clampTick(int256(sd.value2) + step);
                }
            }
        } else if (upper) {
            r.st.upper.clear();
        } else {
            r.st.lower.clear();
        }

        // Everything except the final transfers happens before the keeper's gas is measured: closing the position,
        // the re-fire check, the storage writes. `_settle` then pays the keeper and the owner.
        uint128 left = _positionLiquidity(r.key, r.st.lower.edge, r.st.upper.edge, r.salt);
        bool bothOff = r.st.lower.checker == OrderState.CHECK_OFF && r.st.upper.checker == OrderState.CHECK_OFF;
        if (left == 0 || bothOff) {
            _removeRest(r.key, r.st, orderId);
            delete _orders[orderId];
            emit OrderClosed(orderId);
            _settle(r);
            return;
        }

        // A run must change something, otherwise a keeper could call it again in a loop and drain fees. A side with a
        // hold cannot loop: it needs a new arming and the full wait before it runs again.
        OrderState.Side memory again = upper ? r.st.upper : r.st.lower;
        if (again.checker != OrderState.CHECK_OFF && again.holdMinutes == 0 && _conditionMet(r.key, r.st, again, upper))
        {
            revert WouldRefire();
        }

        (uint256 lo, uint256 up) = _encode(r.st);
        Order storage o = _orders[orderId];
        o.lowerState = lo;
        o.upperState = up;
        emit OrderExecuted(orderId, upper, keeper, lo, up);
        _settle(r);
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

        uint256 out0 = _pos(out.amount0());
        uint256 out1 = _pos(out.amount1());
        r.reserve0 = (out0 * r.order.maxKeeperFeeBps) / BPS;
        r.reserve1 = (out1 * r.order.maxKeeperFeeBps) / BPS;
        // A run that swaps pays the keeper after the swap, out of what the swap produced (see _instantSwap). So the
        // part of the ceiling the keeper does not use comes back in the token the owner asked for, not as a
        // leftover of the token that was sold.
        if (sd.actions & OrderState.ACT_SWAP != 0) {
            if (sd.swapToToken1) r.reserve0 = 0;
            else r.reserve1 = 0;
        }
        uint256 w0 = out0 - r.reserve0;
        uint256 w1 = out1 - r.reserve1;

        if (sd.actions & OrderState.ACT_KEEP_FEES == 0) {
            uint256 f0 = _pos(fees.amount0());
            uint256 f1 = _pos(fees.amount1());
            w0 -= f0 > w0 ? w0 : f0;
            w1 -= f1 > w1 ? w1 : f1;
        }
        r.w0 = w0;
        r.w1 = w1;
    }

    /// @dev The last step of a run: pay the keeper, then send everything else this contract is owed to the owner.
    ///
    /// Keeper pay is the gas this run used, at a capped gas price, plus a premium, and never more than the reserve
    /// (the order's ceiling). Token0 pays first and token1 covers what token0's reserve could not. ETH is paid as it
    /// is; a token amount comes from the Chainlink feeds (wei -> USD -> token). A token whose feed has no answer is
    /// priced from the other token through this pool's price. With no usable feed at all the keeper gets the whole
    /// reserve (the flat ceiling), so a broken feed can never leave an order without a keeper.
    ///
    /// The gas is measured here, after everything but the transfers below, which are covered by fixed allowances.
    function _settle(Run memory r) internal {
        address t0 = Currency.unwrap(r.key.currency0);
        address t1 = Currency.unwrap(r.key.currency1);
        // Read the prices first, so their gas is inside the measurement. per0 / per1 = token units per 1 ETH.
        (bool ok0, uint256 per0) = feeds.quote(t0, 1 ether);
        (bool ok1, uint256 per1) = feeds.quote(t1, 1 ether);
        if (ok0 != ok1) {
            (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(r.key.toId());
            if (ok0) per1 = FullMath.mulDiv(FullMath.mulDiv(per0, sqrtPriceX96, 1 << 96), sqrtPriceX96, 1 << 96);
            else per0 = FullMath.mulDiv(FullMath.mulDiv(per1, 1 << 96, sqrtPriceX96), 1 << 96, sqrtPriceX96);
        }
        // what this contract is owed in this unlock: the keeper's pay comes out of it, the owner gets the rest
        uint256 c0 = _credit(r.key.currency0);
        uint256 c1 = _credit(r.key.currency1);
        if (r.reserve0 > c0) r.reserve0 = c0;
        if (r.reserve1 > c1) r.reserve1 = c1;

        uint256 pay0 = r.reserve0;
        uint256 pay1 = r.reserve1;
        if (ok0 || ok1) {
            uint256 transfers = (c0 > 0 ? 1 : 0) + (c1 > 0 ? 1 : 0); // tokens still to be sent to the owner
            uint256 gasWei = _gasWei(r.gasStart - gasleft(), r.overhead + transfers * r.transferGas);
            uint256 want0 = (FullMath.mulDiv(gasWei, per0, 1 ether) * _premium(t0)) / BPS;
            pay0 = want0 < r.reserve0 ? want0 : r.reserve0;
            // the share of the gas token0 did not cover, paid in token1
            uint256 restWei = want0 == 0 ? gasWei : gasWei - FullMath.mulDiv(gasWei, pay0, want0);
            uint256 want1 = (FullMath.mulDiv(restWei, per1, 1 ether) * _premium(t1)) / BPS;
            pay1 = want1 < r.reserve1 ? want1 : r.reserve1;
        }
        r.key.currency0.take(poolManager, r.keeper, pay0, false);
        r.key.currency1.take(poolManager, r.keeper, pay1, false);
        if (c0 > pay0) _send(r.key.currency0, r.order.owner, c0 - pay0);
        if (c1 > pay1) _send(r.key.currency1, r.order.owner, c1 - pay1);
    }

    function _credit(Currency currency) internal view returns (uint256) {
        int256 d = poolManager.currencyDelta(address(this), currency);
        return d > 0 ? uint256(d) : 0;
    }

    function _premium(address token) internal pure returns (uint256) {
        return token == address(0) ? KEEPER_PREMIUM_BPS : KEEPER_TOKEN_PREMIUM_BPS;
    }

    /// @dev Gas cost in wei before the premium. The gas price counted is capped.
    function _gasWei(uint256 gasUsed, uint256 overhead) internal view returns (uint256) {
        uint256 maxPrice = block.basefee + MAX_PRIORITY_FEE_WEI;
        uint256 price = tx.gasprice < maxPrice ? tx.gasprice : maxPrice;
        return (gasUsed + overhead) * price;
    }

    /// @notice What a keeper is refunded, in wei, for `gasUsed` measured inside execute, when it is paid in ETH.
    function keeperGasCost(uint256 gasUsed) public view returns (uint256) {
        return (_gasWei(gasUsed, KEEPER_GAS_OVERHEAD) * KEEPER_PREMIUM_BPS) / BPS;
    }

    /// @notice The same refund paid in `token` (raw units), at the Chainlink prices. `ok` is false without a price.
    function keeperGasCostIn(address token, uint256 gasUsed) external view returns (bool ok, uint256 amount) {
        (ok, amount) = feeds.quote(token, _gasWei(gasUsed, KEEPER_GAS_OVERHEAD));
        amount = (amount * _premium(token)) / BPS;
    }

    /// @dev A new order must be worth at least the list's minimum, at fresh Chainlink prices.
    function _checkOrderSize(PoolKey memory key, uint256 paid0, uint256 paid1) internal view {
        uint256 min = feeds.minOrderUsd();
        if (min == 0) return;
        (bool ok0, uint256 usd0) = feeds.usdValue(Currency.unwrap(key.currency0), paid0);
        (bool ok1, uint256 usd1) = feeds.usdValue(Currency.unwrap(key.currency1), paid1);
        if (!ok0 || !ok1 || usd0 + usd1 < min) revert OrderTooSmall();
    }

    /// @dev Swap everything of one token into the other, stopping at the slippage limit. If the price is already
    /// past the limit, the swap is skipped and the owner receives the token unswapped. The keeper's ceiling for this
    /// run is then set on what the swap left: the bought amount, plus anything that stayed unsold.
    function _instantSwap(Run memory r, OrderState.Side memory sd, int24 refTick) internal {
        bool zeroForOne = sd.swapToToken1;
        uint256 amountIn = zeroForOne ? r.w0 : r.w1;
        if (amountIn == 0) return;

        PoolKey memory sk = r.order.swapPoolIndex == r.order.poolIndex ? r.key : _key(r.order.swapPoolIndex);
        int256 slip = int256(uint256(r.order.maxSlippage)) * 10;
        int24 limitTick = _clampTick(zeroForOne ? int256(refTick) - slip : int256(refTick) + slip);
        uint160 limit = TickMath.getSqrtPriceAtTick(limitTick);
        (uint160 current,,,) = poolManager.getSlot0(sk.toId());

        uint256 spent;
        uint256 got;
        if (zeroForOne ? limit < current : limit > current) {
            BalanceDelta d = poolManager.swap(
                sk, SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: limit}), ""
            );
            spent = _neg(zeroForOne ? d.amount0() : d.amount1());
            got = _pos(zeroForOne ? d.amount1() : d.amount0());
        }
        uint256 fee = r.order.maxKeeperFeeBps;
        uint256 unsold = ((amountIn - spent) * fee) / BPS;
        uint256 bought = (got * fee) / BPS;
        if (zeroForOne) {
            r.reserve0 = unsold;
            r.reserve1 += bought;
            r.w0 = 0;
        } else {
            r.reserve1 = unsold;
            r.reserve0 += bought;
            r.w1 = 0;
        }
    }

    /// @dev Add the working tokens back: same range, or one-sided next to the current price.
    function _add(Run memory r, OrderState.Side memory sd) internal {
        int256 lower = r.st.lower.edge;
        int256 upper = r.st.upper.edge;
        uint256 a0 = r.w0;
        uint256 a1 = r.w1;

        if (sd.addMode == OrderState.ADD_ONE_SIDED) {
            (, int24 tick,,) = poolManager.getSlot0(r.key.toId());
            int256 s = r.key.tickSpacing;
            int256 floorTick = _floor(tick, r.key.tickSpacing);
            if (r.upper) {
                // price rose out of the range: we hold token1, place it just below the price
                upper = floorTick;
                lower = floorTick - int256(uint256(sd.widthBelow())) * s;
                a0 = 0;
            } else {
                // price fell out of the range: we hold token0, place it just above the price
                lower = floorTick + s;
                upper = lower + int256(uint256(sd.widthAbove())) * s;
                a1 = 0;
            }
            if (lower < TickMath.minUsableTick(r.key.tickSpacing) || upper > TickMath.maxUsableTick(r.key.tickSpacing)) return; // no room: tokens go to the owner and the order closes
        }

        uint128 liq = _liquidityFor(r.key, int24(lower), int24(upper), a0, a1);
        if (liq == 0) return;
        poolManager.modifyLiquidity(
            r.key,
            ModifyLiquidityParams({
                tickLower: int24(lower), tickUpper: int24(upper), liquidityDelta: int256(uint256(liq)), salt: r.salt
            }),
            ""
        );
        r.st.lower.edge = int24(lower);
        r.st.upper.edge = int24(upper);
    }

    /// @dev Remove whatever liquidity the order still has. The tokens stay as a credit in this unlock.
    function _removeRest(PoolKey memory key, OrderState.State memory st, uint256 orderId) internal {
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

    /// @dev Send whatever this contract is owed in the current unlock to `to`.
    function _payOut(PoolKey memory key, address to) internal {
        int256 d0 = poolManager.currencyDelta(address(this), key.currency0);
        int256 d1 = poolManager.currencyDelta(address(this), key.currency1);
        if (d0 > 0) _send(key.currency0, to, uint256(d0));
        if (d1 > 0) _send(key.currency1, to, uint256(d1));
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
        if (currency.isAddressZero() && _trySend(currency, to, amount)) return;
        owed[to][currency] += amount;
        emit PayoutHeld(to, currency, amount);
    }

    /// @dev A transfer that reports failure instead of reverting. ETH gets PAYOUT_GAS and no return data is copied.
    function _trySend(Currency currency, address to, uint256 amount) internal returns (bool ok) {
        if (currency.isAddressZero()) {
            uint256 g = PAYOUT_GAS;
            assembly ("memory-safe") {
                ok := call(g, to, amount, 0, 0, 0, 0)
            }
            return ok;
        }
        address token = Currency.unwrap(currency);
        bytes memory ret;
        (ok, ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer(address,uint256)
        // tokens that return nothing count as success; tokens that return false count as failure
        if (ok && ret.length > 0) ok = ret.length >= 32 && abi.decode(ret, (bool));
    }

    // ---------------------------------------------------------------
    // Conditions
    // ---------------------------------------------------------------

    function _conditionMet(PoolKey memory key, OrderState.State memory st, OrderState.Side memory sd, bool upper)
        internal
        view
        returns (bool)
    {
        bool a = _cond(key, st, sd, upper, sd.checker, sd.value, sd.checkPool);
        if (sd.combine == OrderState.COMBINE_AND) {
            return a && _cond(key, st, sd, upper, sd.checker2, sd.value2, sd.checkPool2);
        }
        if (sd.combine == OrderState.COMBINE_OR) {
            return a || _cond(key, st, sd, upper, sd.checker2, sd.value2, sd.checkPool2);
        }
        return a;
    }

    /// @dev One condition (A or B) of a side.
    function _cond(
        PoolKey memory key,
        OrderState.State memory st,
        OrderState.Side memory sd,
        bool upper,
        uint8 checker,
        int24 value,
        uint24 pool
    ) internal view returns (bool) {
        if (checker == OrderState.CHECK_TIME) {
            return block.timestamp >= uint256(sd.lastRun) + uint256(uint24(value)) * 60;
        }
        if (checker == OrderState.CHECK_EDGE) {
            int256 t = _tick(key);
            return upper ? t >= int256(st.upper.edge) + value : t < int256(st.lower.edge) - value;
        }
        if (checker == OrderState.CHECK_TICK) {
            int256 t = _tick(pool == 0 ? key : _key(pool));
            return upper ? t >= value : t < value;
        }
        if (checker == OrderState.CHECK_TRAIL) {
            int256 t = _tick(pool == 0 ? key : _key(pool));
            return upper ? t >= int256(sd.best) + value : t < int256(sd.best) - value;
        }
        if (checker == OrderState.CHECK_ORACLE) {
            // the pair's Chainlink price, as a tick. A missing or stale price never fires the condition.
            (bool ok, int24 t) = feeds.pairTick(Currency.unwrap(key.currency0), Currency.unwrap(key.currency1));
            return ok && (upper ? t >= value : t < value);
        }
        return false;
    }

    /// @dev A price level: the pool's price or the Chainlink price against a fixed tick. A repeating level steps.
    function _isLevel(uint8 checker) internal pure returns (bool) {
        return checker == OrderState.CHECK_TICK || checker == OrderState.CHECK_ORACLE;
    }

    /// @dev Price the instant swap is protected against: the trigger level of the first condition that is true and is
    /// a price of this pair; otherwise the pool's current price.
    function _refTick(Run memory r, OrderState.Side memory sd) internal view returns (int24) {
        bool aMet = _cond(r.key, r.st, sd, r.upper, sd.checker, sd.value, sd.checkPool);
        if (aMet || sd.combine != OrderState.COMBINE_OR) {
            (bool priced, int24 t) = _refFor(r, sd.checker, sd.value, sd.checkPool, sd.best);
            if (priced) return t;
        }
        if (sd.combine != OrderState.COMBINE_NONE) {
            (bool priced, int24 t) = _refFor(r, sd.checker2, sd.value2, sd.checkPool2, sd.best);
            if (priced) return t;
        }
        return _tick(r.key);
    }

    function _refFor(Run memory r, uint8 checker, int24 value, uint24 pool, int24 best)
        internal
        view
        returns (bool, int24)
    {
        if (checker == OrderState.CHECK_EDGE) {
            return (true, _clampTick(r.upper ? int256(r.st.upper.edge) + value : int256(r.st.lower.edge) - value));
        }
        bool thisPair = pool == 0 || _samePair(r.key, pool);
        if (checker == OrderState.CHECK_TICK && thisPair) return (true, value);
        if (checker == OrderState.CHECK_ORACLE) return (true, value); // always a price of this pair
        if (checker == OrderState.CHECK_TRAIL && thisPair) {
            return (true, _clampTick(r.upper ? int256(best) + value : int256(best) - value));
        }
        return (false, 0);
    }

    /// @dev Whether a side has a trailing condition, and the pool it reads.
    function _trailPool(OrderState.Side memory sd) internal pure returns (bool, uint24) {
        if (sd.checker == OrderState.CHECK_TRAIL) return (true, sd.checkPool);
        if (sd.combine != OrderState.COMBINE_NONE && sd.checker2 == OrderState.CHECK_TRAIL) {
            return (true, sd.checkPool2);
        }
        return (false, 0);
    }

    /// @dev Start a trailing condition from the current price of the pool it reads.
    function _startTrail(PoolKey memory key, OrderState.Side memory sd) internal view {
        (bool trails, uint24 pool) = _trailPool(sd);
        if (trails) sd.best = _tick(pool == 0 ? key : _key(pool));
    }

    /// @dev A side with a hold runs between holdMinutes and 2 x holdMinutes after it was armed (and its condition must
    /// still be true then). Later than that the arming has expired and the side must be armed again.
    function _held(OrderState.Side memory sd) internal view returns (bool) {
        if (sd.holdMinutes == 0) return true;
        if (sd.armedAt == 0) return false;
        uint256 hold = uint256(sd.holdMinutes) * 60;
        return block.timestamp >= uint256(sd.armedAt) + hold && block.timestamp <= uint256(sd.armedAt) + 2 * hold;
    }

    /// @dev No run or poke right after a swap in the same transaction in any pool the side reads (hook pools only):
    /// a flash-loaned price push followed by execute (then a swap back) is the cheap way to force a trigger.
    function _checkSideNoSwap(PoolKey memory key, OrderState.Side memory sd) internal view {
        if (hook.swappedThisTx(key.toId())) revert SwappedThisTx();
        _checkNoSwap(sd.checkPool);
        if (sd.combine != OrderState.COMBINE_NONE) _checkNoSwap(sd.checkPool2);
    }

    /// @dev Refuse to run right after a swap in this transaction in a pool a condition reads (hook pools only).
    function _checkNoSwap(uint24 pool) internal view {
        if (pool != 0 && hook.swappedThisTx(_key(pool).toId())) revert SwappedThisTx();
    }

    /// @dev A side must be exactly one the app's rule editor can build; anything else reverts (InvalidSide). The rules:
    ///  - off side: every field zero. Fields the contract keeps itself (edge, lastRun, armedAt, best) must be zero too.
    ///  - actions: without remove only "compound" (keep fees + add); remove 0% means "send fees out" (no keep, no
    ///    swap); swap needs a real withdrawal and no add; swapToToken1 only with swap; addMode only with add.
    ///  - one-sided re-range ("follow"): condition A leaves the range (B only with AND), removes 100%, and `shape`
    ///    holds the one width that side uses (upper: below the price, lower: above it).
    ///  - `shape` is otherwise the step of a repeating price level, and zero when nothing steps.
    ///  - a repeating side must stop being true after a run, or it would fire again at once.
    function _validateSide(OrderState.Side calldata d, bool upper, int24 tickSpacing, uint24 ownIndex) internal view {
        if (d.edge != 0 || d.lastRun != 0 || d.armedAt != 0 || d.best != 0) revert InvalidSide();
        if (d.checker == OrderState.CHECK_OFF) {
            if (
                d.value != 0 || d.checkPool != 0 || d.checker2 != 0 || d.value2 != 0 || d.checkPool2 != 0
                    || d.combine != 0 || d.holdMinutes != 0 || d.actions != 0 || d.removeBps != 0 || d.swapToToken1
                    || d.addMode != 0 || d.repeat || d.runsLeft != 0 || d.shape != 0
            ) revert InvalidSide();
            return;
        }

        // ---- actions
        if (d.actions == 0 || d.actions > 15 || d.removeBps > BPS) revert InvalidSide();
        bool remove = d.actions & OrderState.ACT_REMOVE != 0;
        bool keep = d.actions & OrderState.ACT_KEEP_FEES != 0;
        bool swap = d.actions & OrderState.ACT_SWAP != 0;
        bool add = d.actions & OrderState.ACT_ADD != 0;
        if (!remove) {
            if (d.actions != (OrderState.ACT_KEEP_FEES | OrderState.ACT_ADD) || d.removeBps != 0) revert InvalidSide();
        } else if (d.removeBps == 0 && (keep || swap)) {
            revert InvalidSide(); // removing nothing only sends the fees out
        }
        if (swap && add) revert InvalidSide(); // swap-to-ratio is not in v1
        if (d.swapToToken1 && !swap) revert InvalidSide();
        if (d.addMode > (add ? OrderState.ADD_ONE_SIDED : 0)) revert InvalidSide();
        bool oneSided = add && d.addMode == OrderState.ADD_ONE_SIDED; // the range moves after a run

        // ---- conditions
        _validateCond(d.checker, d.value, d.checkPool, ownIndex);
        if (d.combine == OrderState.COMBINE_NONE) {
            if (d.checker2 != 0 || d.value2 != 0 || d.checkPool2 != 0) revert InvalidSide();
        } else {
            if (d.combine > OrderState.COMBINE_OR || d.checker2 == OrderState.CHECK_OFF) revert InvalidSide();
            _validateCond(d.checker2, d.value2, d.checkPool2, ownIndex);
        }
        bool hasB = d.combine != OrderState.COMBINE_NONE;
        bool trailA = d.checker == OrderState.CHECK_TRAIL;
        bool trailB = hasB && d.checker2 == OrderState.CHECK_TRAIL;
        // one memo per side: one trailing condition at most, and not together with a hold
        if ((trailA && trailB) || ((trailA || trailB) && d.holdMinutes != 0)) revert InvalidSide();
        if (d.runsLeft != 0 && !d.repeat) revert InvalidSide(); // a run limit only means something with repeat

        // ---- shape
        if (oneSided) {
            if (d.checker != OrderState.CHECK_EDGE || d.removeBps != BPS) revert InvalidSide();
            // the new range goes next to the price on this side's side, so the price must have left the range that
            // way: with OR, condition B alone could fire it while the price is still in range or past the other edge
            if (d.combine == OrderState.COMBINE_OR) revert InvalidSide();
            uint24 used = upper ? d.shape & OrderState.MAX_WIDTH : (d.shape >> 11) & OrderState.MAX_WIDTH;
            uint24 unused = upper ? (d.shape >> 11) & OrderState.MAX_WIDTH : d.shape & OrderState.MAX_WIDTH;
            if (used == 0 || unused != 0 || d.shape > OrderState.MAX_SHAPE) revert InvalidSide();
            // the new range sits next to the price, so the trigger needs at least one spacing of room
            if (d.repeat && d.value < tickSpacing) revert InvalidSide();
        } else {
            bool steps = d.repeat && (_isLevel(d.checker) || (hasB && _isLevel(d.checker2)));
            if (steps ? (d.shape == 0 || d.shape > OrderState.MAX_SHAPE) : d.shape != 0) revert InvalidSide();
        }

        // ---- a repeating side must stop being true after it runs
        if (d.repeat) {
            if (d.checker == OrderState.CHECK_EDGE && !oneSided) revert InvalidSide(); // the range does not move
            if (d.combine == OrderState.COMBINE_OR) {
                // either condition alone fires, so B must stop being true as well
                if (d.checker2 == OrderState.CHECK_EDGE && !oneSided) revert InvalidSide();
                if (_isLevel(d.checker2) && oneSided) revert InvalidSide(); // its level cannot step
            }
        }
    }

    /// @dev Checks shared by condition A and condition B.
    function _validateCond(uint8 checker, int24 value, uint24 pool, uint24 ownIndex) internal view {
        if (checker == OrderState.CHECK_OFF || checker > OrderState.CHECK_ORACLE) revert InvalidSide();
        if (_isLevel(checker) && (value <= TickMath.MIN_TICK || value >= TickMath.MAX_TICK)) revert InvalidSide();
        if (checker == OrderState.CHECK_EDGE && value < 0) revert InvalidSide();
        if (checker == OrderState.CHECK_TIME && value <= 0) revert InvalidSide();
        // a trailing distance is a fall of less than 99.99% (or the same number of ticks up)
        if (checker == OrderState.CHECK_TRAIL && (value <= 0 || value > OrderState.MAX_TRAIL)) revert InvalidSide();
        if (checker == OrderState.CHECK_TICK) {
            // 0 = the order's own pool; another pool is named by its index, never by the own pool's index
            if (pool > hook.poolCount()) revert UnknownPool();
            if (pool == ownIndex) revert InvalidSide();
        } else if (pool != 0) {
            // only a pool price level reads another pool. A trailing stop reads the order's own pool: its remembered
            // high or low must come from a pool the same-transaction guard covers. A Chainlink level is always the
            // order's own pair.
            revert InvalidSide();
        }
    }

    // ---------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------

    function _positionLiquidity(PoolKey memory key, int24 tickLower, int24 tickUpper, bytes32 salt)
        internal
        view
        returns (uint128)
    {
        bytes32 positionId = Position.calculatePositionKey(address(this), tickLower, tickUpper, salt);
        return poolManager.getPositionLiquidity(key.toId(), positionId);
    }

    function _liquidityFor(PoolKey memory key, int24 tickLower, int24 tickUpper, uint256 a0, uint256 a1)
        internal
        view
        returns (uint128)
    {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        // keep 1 wei back: the PoolManager rounds the amounts it asks for up
        a0 = a0 > 0 ? a0 - 1 : 0;
        a1 = a1 > 0 ? a1 - 1 : 0;
        return LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96, TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), a0, a1
        );
    }

    /// @dev Memo fields are kept by the contract, never taken from the caller.
    function _resetMemo(OrderState.Side memory d) internal pure {
        d.armedAt = 0;
        d.best = 0;
    }

    function _decode(Order memory o) internal pure returns (OrderState.State memory st) {
        st.lower = OrderState.decodeSide(o.lowerState);
        st.upper = OrderState.decodeSide(o.upperState);
    }

    function _encode(OrderState.State memory st) internal pure returns (uint256 lo, uint256 up) {
        lo = OrderState.encodeSide(st.lower);
        up = OrderState.encodeSide(st.upper);
    }

    function _key(uint24 index) internal view returns (PoolKey memory) {
        return hook.poolKeyAt(index);
    }

    function _samePair(PoolKey memory key, uint24 index) internal view returns (bool) {
        if (index == 0 || index > hook.poolCount()) return false;
        PoolKey memory other = hook.poolKeyAt(index);
        return other.currency0 == key.currency0 && other.currency1 == key.currency1;
    }

    function _tick(PoolKey memory key) internal view returns (int24 tick) {
        (, tick,,) = poolManager.getSlot0(key.toId());
    }

    function _floor(int24 tick, int24 spacing) internal pure returns (int256) {
        int256 c = int256(tick) / spacing;
        if (tick < 0 && int256(tick) % spacing != 0) c--;
        return c * spacing;
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
