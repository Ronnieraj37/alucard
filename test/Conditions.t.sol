// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {RuleSetup} from "./utils/RuleSetup.sol";
import {Rules} from "../src/Rules.sol";
import {ConditionalOrders} from "../src/ConditionalOrders.sol";
import {OrderState} from "../src/libraries/OrderState.sol";
import {IAlucardCondition} from "../src/interfaces/IAlucardCondition.sol";
import {DepegCondition} from "../src/examples/DepegCondition.sol";

/// A card that answers what it is told.
contract SwitchCard is IAlucardCondition {
    bool public on;

    function set(bool v) external {
        on = v;
    }

    function isMet(address, uint256, bool) external view returns (bool) {
        return on;
    }
}

/// Cards that misbehave: each must count as "not now".
contract RevertingCard {
    function isMet(address, uint256, bool) external pure returns (bool) {
        revert("no");
    }
}

contract GasHogCard {
    function isMet(address, uint256, bool) external pure returns (bool) {
        while (true) {}
        return true;
    }
}

contract JunkCard {
    function isMet(address, uint256, bool) external pure returns (uint256) {
        return 2; // not a clean true
    }
}

contract WritingCard {
    uint256 public calls;

    function isMet(address, uint256, bool) external returns (bool) {
        calls++; // a write: not allowed in a read-only call
        return true;
    }
}

/// @notice An order's own condition: a contract its owner pastes in, answering true or false.
contract ConditionsTest is RuleSetup {
    SwitchCard card;

    function setUp() public override {
        super.setUp();
        card = new SwitchCard();
    }

    function _own() internal pure returns (OrderState.Side memory) {
        return _exit(OrderState.CHECK_EXTERNAL, 0);
    }

    function _withCondition(OrderState.Side memory lower, address condition) internal returns (uint256) {
        ConditionalOrders.CreateParams memory p = _params(lower, _off());
        p.condition = condition;
        return _submit(alice, p);
    }

    function test_theContractDecidesWhen() public {
        uint256 orderId = _withCondition(_own(), address(card));
        assertEq(orders.conditionOf(orderId), address(card));
        _wait(2 minutes);
        assertFalse(rules.canExecute(orders, orderId, false));
        vm.expectRevert(ConditionalOrders.ConditionNotMet.selector);
        _run(orderId, false);
        card.set(true);
        assertTrue(rules.canExecute(orders, orderId, false));
        _run(orderId, false);
        assertEq(orders.getOrder(orderId).owner, address(0));
        assertEq(orders.conditionOf(orderId), address(0)); // cleared when the order closes
    }

    function test_itCombinesWithAnd() public {
        OrderState.Side memory low = _own();
        low.combine = OrderState.COMBINE_AND;
        low.checker2 = OrderState.CHECK_TIME;
        low.value2 = 60; // and an hour has passed
        uint256 orderId = _withCondition(low, address(card));
        card.set(true);
        _wait(2 minutes);
        assertFalse(rules.canExecute(orders, orderId, false));
        _wait(1 hours);
        assertTrue(rules.canExecute(orders, orderId, false));
    }

    function test_misbehavingContractsNeverFire() public {
        address[4] memory bad = [address(new RevertingCard()), address(new GasHogCard()), address(new JunkCard()), address(new WritingCard())];
        for (uint256 i; i < bad.length; ++i) {
            uint256 orderId = _withCondition(_own(), bad[i]);
            _wait(2 minutes);
            assertFalse(rules.canExecute(orders, orderId, false));
        }
    }

    function test_theAddressMustBeAContract() public {
        ConditionalOrders.CreateParams memory p = _params(_own(), _off());
        p.condition = makeAddr("nobody");
        vm.prank(alice);
        vm.expectRevert(ConditionalOrders.BadCondition.selector);
        orders.createOrder(p);
    }

    /// No address, no storage: a side that asks for its own condition without one simply never fires.
    function test_noAddressNeverFires() public {
        uint256 orderId = _create(_own(), _off());
        assertEq(orders.conditionOf(orderId), address(0));
        _wait(2 minutes);
        assertFalse(rules.canExecute(orders, orderId, false));
    }

    function test_theOwnerCanChangeIt() public {
        uint256 orderId = _withCondition(_own(), address(card));
        SwitchCard other = new SwitchCard();
        other.set(true);
        ConditionalOrders.Order memory o = orders.getOrder(orderId);
        ConditionalOrders.UpdateParams memory u = ConditionalOrders.UpdateParams({
            expiry: o.expiry, keeperFeeBps: o.keeperFeeBps, maxSlippage: o.maxSlippage, lower: _w(_own()), upper: 0, condition: address(other)
        });
        vm.prank(alice);
        orders.updateOrder(orderId, u);
        assertEq(orders.conditionOf(orderId), address(other));
        _wait(2 minutes);
        assertTrue(rules.canExecute(orders, orderId, false));
    }

    function test_theExampleDepegContract() public {
        DepegCondition depeg = new DepegCondition(address(feed1), 0.99e8, 1 days); // token1's feed reads $1
        uint256 orderId = _withCondition(_own(), address(depeg));
        _wait(2 minutes);
        assertFalse(rules.canExecute(orders, orderId, false));
        feed1.setAnswer(0.985e8); // token1 loses its peg
        assertTrue(rules.canExecute(orders, orderId, false));
    }
}
