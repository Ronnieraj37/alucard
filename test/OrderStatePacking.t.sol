// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {OrderState} from "../src/libraries/OrderState.sol";

/// @dev External wrapper so reverts inside the library can be caught with expectRevert.
contract Packer {
    function encode(OrderState.Side memory d) external pure returns (uint256) {
        return OrderState.encodeSide(d);
    }
}

/// @notice Proves the packed side word is collision-free: every field round-trips at its extremes, writing one field
/// never changes another, fields sit at their documented bits, and out-of-range values are rejected instead of
/// wrapping.
contract OrderStatePackingTest is Test {
    Packer packer = new Packer();
    uint256 constant FIELDS = 18;
    uint32 constant MAX_TIME = uint32(OrderState.BASE_TIME + uint256(0xFFFFFF) * 60);

    // ---------------------------------------------------------------- helpers

    /// Every field at its largest legal value (`hold` only changes holdMinutes, kept for the loop below).
    function _maxSide(bool negative, bool hold) internal pure returns (OrderState.Side memory d) {
        d.edge = negative ? TickMath.MIN_TICK : TickMath.MAX_TICK;
        d.checker = OrderState.MAX_CHECKER;
        d.value = negative ? type(int24).min : type(int24).max;
        d.checkPool = type(uint24).max;
        d.actions = OrderState.MAX_ACTIONS;
        d.removeBps = 10_000;
        d.swapToToken1 = true;
        d.addMode = 7;
        d.repeat = true;
        d.shape = OrderState.MAX_SHAPE;
        d.lastRun = MAX_TIME;
        d.checker2 = OrderState.MAX_CHECKER;
        d.value2 = negative ? type(int24).max : type(int24).min;
        d.checkPool2 = type(uint24).max;
        d.combine = 2;
        d.runsLeft = OrderState.MAX_RUNS;
        d.holdMinutes = hold ? type(uint16).max : 1;
        d.best = negative ? type(int24).min : type(int24).max;
    }

    function _h(uint256 seed, uint256 k) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, k)));
    }

    /// A time that survives the minute rounding unchanged.
    function _time(uint256 r) internal pure returns (uint32) {
        return uint32(OrderState.BASE_TIME + (r % 0xFFFFFF + 1) * 60);
    }

    function _random(uint256 seed) internal pure returns (OrderState.Side memory d) {
        for (uint256 k; k < FIELDS; ++k) {
            _setField(d, k, _h(seed, k));
        }
    }

    /// Set field `k` of `d` to a legal value derived from `seed`.
    function _setField(OrderState.Side memory d, uint256 k, uint256 seed) internal pure {
        if (k == 0) {
            d.edge = int24(int256(seed % 1_774_545) - 887_272);
        } else if (k == 1) {
            d.checker = uint8(seed % 64);
        } else if (k == 2) {
            d.value = int24(uint24(seed));
        } else if (k == 3) {
            d.checkPool = uint24(seed);
        } else if (k == 4) {
            d.actions = uint8(seed % (uint256(OrderState.MAX_ACTIONS) + 1));
        } else if (k == 5) {
            d.removeBps = uint16(seed % 10_001);
        } else if (k == 6) {
            d.swapToToken1 = !d.swapToToken1;
        } else if (k == 7) {
            d.addMode = uint8(seed % 8);
        } else if (k == 8) {
            d.repeat = !d.repeat;
        } else if (k == 9) {
            d.shape = uint24(seed % (uint256(OrderState.MAX_SHAPE) + 1));
        } else if (k == 10) {
            d.lastRun = seed % 5 == 0 ? 0 : _time(seed);
        } else if (k == 11) {
            d.checker2 = uint8(seed % 64);
        } else if (k == 12) {
            d.value2 = int24(uint24(seed));
        } else if (k == 13) {
            d.checkPool2 = uint24(seed);
        } else if (k == 14) {
            d.combine = uint8(seed % 3);
        } else if (k == 15) {
            d.holdMinutes = uint16(seed);
        } else if (k == 16) {
            d.best = int24(uint24(seed));
        } else if (k == 17) {
            d.runsLeft = uint8(seed % (uint256(OrderState.MAX_RUNS) + 1));
        }
    }

    function _roundTrip(OrderState.Side memory d) internal pure returns (OrderState.Side memory) {
        return OrderState.decodeSide(OrderState.encodeSide(d));
    }

    // ---------------------------------------------------------------- extremes

    function test_allFieldsAtMaximum() public pure {
        for (uint256 n; n < 4; ++n) {
            OrderState.Side memory d = _maxSide(n % 2 == 0, n < 2);
            assertEq(abi.encode(_roundTrip(d)), abi.encode(d));
        }
    }

    /// One field set to its maximum, everything else zero: no other field may read non-zero.
    function test_eachFieldAloneDoesNotLeak() public pure {
        OrderState.Side memory full = _maxSide(true, false);
        OrderState.Side memory fullHold = _maxSide(false, true);
        for (uint256 k; k < FIELDS; ++k) {
            OrderState.Side memory one;
            if (k == 0) one.edge = full.edge;
            if (k == 1) one.checker = full.checker;
            if (k == 2) one.value = full.value;
            if (k == 3) one.checkPool = full.checkPool;
            if (k == 4) one.actions = full.actions;
            if (k == 5) one.removeBps = full.removeBps;
            if (k == 6) one.swapToToken1 = true;
            if (k == 7) one.addMode = full.addMode;
            if (k == 8) one.repeat = true;
            if (k == 9) one.shape = full.shape;
            if (k == 10) one.lastRun = full.lastRun;
            if (k == 11) one.checker2 = full.checker2;
            if (k == 12) one.value2 = full.value2;
            if (k == 13) one.checkPool2 = full.checkPool2;
            if (k == 14) one.combine = full.combine;
            if (k == 15) one.holdMinutes = fullHold.holdMinutes;
            if (k == 16) one.best = full.best;
            if (k == 17) one.runsLeft = full.runsLeft;
            assertEq(abi.encode(_roundTrip(one)), abi.encode(one));
        }
    }

    /// Exact bit positions, so the layout cannot drift from the documented one.
    function test_documentedBitPositions() public pure {
        OrderState.Side memory d;
        d.edge = -1;
        d.checker = OrderState.MAX_CHECKER;
        d.value = -1;
        d.checkPool = 0xABCDEF;
        d.checker2 = 0x2A;
        d.value2 = -2;
        d.checkPool2 = 0x123456;
        d.combine = 2;
        d.holdMinutes = 0xBEEF;
        d.lastRun = uint32(OrderState.BASE_TIME + 0x654321 * 60);
        d.best = 0x111111;
        d.actions = 0x1F;
        d.removeBps = 10_000;
        d.swapToToken1 = true;
        d.addMode = 5;
        d.repeat = true;
        d.runsLeft = 0x55;
        d.shape = 0x2AAAAA;
        uint256 w = OrderState.encodeSide(d);
        assertEq(w & 0xFFFFFF, 0xFFFFFF, "edge 0-23");
        assertEq((w >> 24) & 0x3F, 0x3F, "checker 24-29");
        assertEq((w >> 30) & 0xFFFFFF, 0xFFFFFF, "value 30-53");
        assertEq((w >> 54) & 0xFFFFFF, 0xABCDEF, "checkPool 54-77");
        assertEq((w >> 78) & 0x3F, 0x2A, "checker2 78-83");
        assertEq((w >> 84) & 0xFFFFFF, 0xFFFFFE, "value2 84-107");
        assertEq((w >> 108) & 0xFFFFFF, 0x123456, "checkPool2 108-131");
        assertEq((w >> 132) & 0x3, 2, "combine 132-133");
        assertEq((w >> 134) & 0xFFFF, 0xBEEF, "holdMinutes 134-149");
        assertEq((w >> 150) & 0xFFFFFF, 0x654321, "lastRun 150-173");
        assertEq((w >> 174) & 0xFFFFFF, 0x111111, "best 174-197");
        assertEq((w >> 198) & 0xFF, 0x1F, "actions 198-205");
        assertEq((w >> 206) & 0x3FFF, 10_000, "removeBps 206-219");
        assertEq((w >> 220) & 1, 1, "swapToToken1 220");
        assertEq((w >> 221) & 0x7, 5, "addMode 221-223");
        assertEq((w >> 224) & 1, 1, "repeat 224");
        assertEq((w >> 225) & 0x7F, 0x55, "runsLeft 225-231");
        assertEq((w >> 232) & 0x3FFFFF, 0x2AAAAA, "shape 232-253");
        assertEq(w >> 254, 0, "spare 254-255");
    }

    /// The trailing best tick is signed and kept together with a hold.
    function test_bestIsSignedAndKeptWithAHold() public pure {
        OrderState.Side memory d;
        d.best = -887_000;
        d.holdMinutes = 30;
        uint256 w = OrderState.encodeSide(d);
        assertEq((w >> 174) & 0xFFFFFF, uint256(uint24(int24(-887_000))));
        assertEq(OrderState.decodeSide(w).best, -887_000);
        assertEq(OrderState.decodeSide(w).holdMinutes, 30);
    }

    // ---------------------------------------------------------------- fuzz

    /// Change any one field: that field changes, nothing else does.
    function testFuzz_changingOneFieldChangesOnlyThatField(uint256 seed, uint256 k, uint256 v) public pure {
        OrderState.Side memory d = _random(seed);
        OrderState.Side memory changed = _roundTrip(d);
        assertEq(abi.encode(changed), abi.encode(d));
        _setField(changed, k % FIELDS, v);
        assertEq(abi.encode(_roundTrip(changed)), abi.encode(changed));
    }

    function testFuzz_roundTrip(uint256 seed) public pure {
        OrderState.Side memory d = _random(seed);
        assertEq(abi.encode(_roundTrip(d)), abi.encode(d));
    }

    // ---------------------------------------------------------------- rejected values

    function test_outOfRangeValuesRevertInsteadOfWrapping() public {
        OrderState.Side memory d;
        d.checker = 64;
        vm.expectRevert(OrderState.FieldTooLarge.selector);
        packer.encode(d);

        d.checker = 1;
        d.checker2 = 64;
        vm.expectRevert(OrderState.FieldTooLarge.selector);
        packer.encode(d);

        d.checker2 = 0;
        d.actions = OrderState.MAX_ACTIONS + 1;
        vm.expectRevert(OrderState.FieldTooLarge.selector);
        packer.encode(d);

        d.actions = 0;
        d.removeBps = 10_001;
        vm.expectRevert(OrderState.FieldTooLarge.selector);
        packer.encode(d);

        d.removeBps = 0;
        d.addMode = 8;
        vm.expectRevert(OrderState.FieldTooLarge.selector);
        packer.encode(d);

        d.addMode = 0;
        d.combine = 3;
        vm.expectRevert(OrderState.FieldTooLarge.selector);
        packer.encode(d);

        d.combine = 0;
        d.runsLeft = OrderState.MAX_RUNS + 1;
        vm.expectRevert(OrderState.FieldTooLarge.selector);
        packer.encode(d);

        d.runsLeft = 0;
        d.shape = OrderState.MAX_SHAPE + 1;
        vm.expectRevert(OrderState.FieldTooLarge.selector);
        packer.encode(d);

        d.shape = 0;
        d.lastRun = uint32(OrderState.BASE_TIME - 1);
        vm.expectRevert(OrderState.TimeBeforeBase.selector);
        packer.encode(d);

        d.lastRun = MAX_TIME + 60;
        vm.expectRevert(OrderState.FieldTooLarge.selector);
        packer.encode(d);
    }

    /// Times are stored in minutes rounded up: never earlier than the real time, at most 59 s later.
    function testFuzz_timesNeverEarly(uint32 t) public pure {
        t = uint32(bound(t, OrderState.BASE_TIME + 1, MAX_TIME));
        OrderState.Side memory d;
        d.lastRun = t;
        OrderState.Side memory back = _roundTrip(d);
        assertGe(back.lastRun, t);
        assertLt(back.lastRun, uint256(t) + 60);
    }
}
