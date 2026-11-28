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

/// @notice "When" cards: a contract anyone writes, answering true or false.
contract ConditionsTest is RuleSetup {
    SwitchCard card;
    uint24 id;

    function setUp() public override {
        super.setUp();
        card = new SwitchCard();
        id = rules.registerCondition(address(card));
    }

    function _cardSide(uint24 cardId) internal pure returns (OrderState.Side memory) {
        return _exit(OrderState.CHECK_EXTERNAL, int24(cardId));
    }

    function test_aCardDecidesWhen() public {
        uint256 orderId = _create(_cardSide(id), _off());
        _wait(2 minutes);
        assertFalse(rules.canExecute(orders, orderId, false));
        vm.expectRevert(ConditionalOrders.ConditionNotMet.selector);
        _run(orderId, false);
        card.set(true);
        assertTrue(rules.canExecute(orders, orderId, false));
        _run(orderId, false);
        assertEq(orders.getOrder(orderId).owner, address(0));
    }

    function test_aCardCombinesWithAnd() public {
        OrderState.Side memory low = _cardSide(id);
        low.combine = OrderState.COMBINE_AND;
        low.checker2 = OrderState.CHECK_TIME;
        low.value2 = 60; // and an hour has passed
        uint256 orderId = _create(low, _off());
        card.set(true);
        _wait(2 minutes);
        assertFalse(rules.canExecute(orders, orderId, false));
        _wait(1 hours);
        assertTrue(rules.canExecute(orders, orderId, false));
    }

    function test_misbehavingCardsNeverFire() public {
        address[4] memory bad = [address(new RevertingCard()), address(new GasHogCard()), address(new JunkCard()), address(new WritingCard())];
        for (uint256 i; i < bad.length; ++i) {
            uint256 orderId = _create(_cardSide(rules.registerCondition(bad[i])), _off());
            _wait(2 minutes);
            assertFalse(rules.canExecute(orders, orderId, false));
        }
    }

    function test_registering() public {
        assertEq(rules.registerCondition(address(card)), id); // once per contract
        assertEq(rules.conditionAt(id), address(card));
        vm.expectRevert(Rules.NotAContract.selector);
        rules.registerCondition(makeAddr("nobody"));
        // an order can only name a registered card
        vm.prank(alice);
        vm.expectRevert(Rules.InvalidSide.selector);
        orders.createOrder(_params(_cardSide(id + 1), _off()));
    }

    function test_theExampleDepegCard() public {
        DepegCondition depeg = new DepegCondition(address(feed1), 0.99e8, 1 days); // token1's feed reads $1
        uint256 orderId = _create(_cardSide(rules.registerCondition(address(depeg))), _off());
        _wait(2 minutes);
        assertFalse(rules.canExecute(orders, orderId, false));
        feed1.setAnswer(0.985e8); // token1 loses its peg
        assertTrue(rules.canExecute(orders, orderId, false));
    }
}
