// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title OrderState
/// @notice Packs the part of an order that changes on every run. Each side of the order is one full 256-bit word
/// (one storage slot): the lower side fires when the price falls, the upper side when it rises (or on time).
/// Checking one side never reads the other side's slot.
///
/// Side layout (bit offsets inside the side's word):
///   0-23     edge        int24  where this side of the position sits: tickLower (lower side) or tickUpper (upper
///                               side). Any sign. Moves only when the position is re-ranged.
///   24-29    checker     condition A: 0 off, 1 EDGE, 2 TICK, 3 TIME, 4 TRAIL (up to 63)
///   30-53    value       int24  condition A's number. EDGE: ticks past the edge; TICK: a price level (tick);
///                               TIME: minutes; TRAIL: ticks back from the best price seen
///   54-77    checkPool   uint24 pool condition A reads (TICK, TRAIL). 0 = the order's own pool
///   78-83    checker2    condition B, same kinds as A (0 = no condition B)
///   84-107   value2      int24  condition B's number
///   108-131  checkPool2  uint24 pool condition B reads
///   132-133  combine     0 = A only, 1 = A and B, 2 = A or B
///   134-149  holdMinutes uint16 the condition must be true when armed and still true this many minutes later
///   150-173  lastRun     uint24 minutes since BASE_TIME, rounded up (valid until 2057). 0 = never
///   174-197  memo        uint24 holdMinutes > 0: armedAt, minutes since BASE_TIME rounded up (0 = not armed).
///                               otherwise: best (int24), the best tick seen by a TRAIL condition
///   198-205  actions     bit0 keep fees in the order, bit1 remove, bit2 swap, bit3 add (bits 4-7 spare)
///   206-219  removeBps   0-10,000
///   220      swapToToken1
///   221-223  addMode     0 same range, 1 one-sided next to the price
///   224      repeat
///   225-231  runsLeft    with repeat: runs left before the side switches off (0 = no limit)
///   232-253  shape       with add: widthBelow (bits 0-10) + widthAbove (bits 11-21), in tick spacings
///                        without add: step in ticks for a repeating TICK side
///   254-255  spare
library OrderState {
    error FieldTooLarge();
    error TimeBeforeBase();
    error MemoConflict();

    uint8 internal constant CHECK_OFF = 0;
    uint8 internal constant CHECK_EDGE = 1;
    uint8 internal constant CHECK_TICK = 2;
    uint8 internal constant CHECK_TIME = 3;
    uint8 internal constant CHECK_TRAIL = 4;
    uint8 internal constant CHECK_ORACLE = 5; // the pair's Chainlink price as a tick, compared like CHECK_TICK
    uint8 internal constant MAX_CHECKER = 63;

    uint8 internal constant ACT_KEEP_FEES = 1;
    uint8 internal constant ACT_REMOVE = 2;
    uint8 internal constant ACT_SWAP = 4;
    uint8 internal constant ACT_ADD = 8;

    uint8 internal constant ADD_SAME_RANGE = 0;
    uint8 internal constant ADD_ONE_SIDED = 1;

    uint8 internal constant COMBINE_NONE = 0;
    uint8 internal constant COMBINE_AND = 1;
    uint8 internal constant COMBINE_OR = 2;

    uint24 internal constant MAX_WIDTH = 2047; // 11 bits
    uint24 internal constant MAX_SHAPE = (1 << 22) - 1;
    uint8 internal constant MAX_RUNS = 127;
    /// @dev Largest trailing distance in ticks: a 99.99% fall (ln(10000) / ln(1.0001)).
    int24 internal constant MAX_TRAIL = 92_108;

    /// @dev 2026-01-01 00:00:00 UTC. Times are stored as minutes after this.
    uint256 internal constant BASE_TIME = 1_767_225_600;

    struct Side {
        int24 edge;
        uint8 checker;
        int24 value;
        uint24 checkPool;
        uint8 actions;
        uint16 removeBps;
        bool swapToToken1;
        uint8 addMode;
        bool repeat;
        uint24 shape;
        uint32 lastRun; // unix seconds
        uint8 checker2;
        int24 value2;
        uint24 checkPool2;
        uint8 combine;
        uint16 holdMinutes;
        uint32 armedAt; // unix seconds, holdMinutes > 0 only
        int24 best; // TRAIL only, holdMinutes == 0
        uint8 runsLeft;
    }

    struct State {
        Side lower;
        Side upper;
    }

    function encodeSide(Side memory d) internal pure returns (uint256 v) {
        if (
            d.checker > MAX_CHECKER || d.checker2 > MAX_CHECKER || d.actions > 15 || d.removeBps > 10_000
                || d.addMode > 7 || d.combine > 2 || d.runsLeft > MAX_RUNS || d.shape > MAX_SHAPE
        ) revert FieldTooLarge();
        uint256 memo;
        if (d.holdMinutes > 0) {
            if (d.best != 0) revert MemoConflict();
            memo = _minutes(d.armedAt);
        } else {
            if (d.armedAt != 0) revert MemoConflict();
            memo = uint24(d.best);
        }
        v = uint256(uint24(d.edge)) | (uint256(d.checker) << 24) | (uint256(uint24(d.value)) << 30)
            | (uint256(d.checkPool) << 54) | (uint256(d.checker2) << 78) | (uint256(uint24(d.value2)) << 84)
            | (uint256(d.checkPool2) << 108) | (uint256(d.combine) << 132) | (uint256(d.holdMinutes) << 134)
            | (_minutes(d.lastRun) << 150) | (memo << 174) | (uint256(d.actions) << 198) | (uint256(d.removeBps) << 206)
            | (_bit(d.swapToToken1) << 220) | (uint256(d.addMode) << 221) | (_bit(d.repeat) << 224)
            | (uint256(d.runsLeft) << 225) | (uint256(d.shape) << 232);
    }

    function decodeSide(uint256 v) internal pure returns (Side memory d) {
        d.edge = int24(uint24(v));
        d.checker = uint8((v >> 24) & 0x3F);
        d.value = int24(uint24(v >> 30));
        d.checkPool = uint24(v >> 54);
        d.checker2 = uint8((v >> 78) & 0x3F);
        d.value2 = int24(uint24(v >> 84));
        d.checkPool2 = uint24(v >> 108);
        d.combine = uint8((v >> 132) & 0x3);
        d.holdMinutes = uint16(v >> 134);
        d.lastRun = _time(uint24(v >> 150));
        uint24 memo = uint24(v >> 174);
        if (d.holdMinutes > 0) d.armedAt = _time(memo);
        else d.best = int24(memo);
        d.actions = uint8((v >> 198) & 0xF);
        d.removeBps = uint16((v >> 206) & 0x3FFF);
        d.swapToToken1 = (v >> 220) & 1 == 1;
        d.addMode = uint8((v >> 221) & 0x7);
        d.repeat = (v >> 224) & 1 == 1;
        d.runsLeft = uint8((v >> 225) & 0x7F);
        d.shape = uint24((v >> 232) & MAX_SHAPE);
    }

    function widthBelow(Side memory d) internal pure returns (uint24) {
        return d.shape & MAX_WIDTH;
    }

    function widthAbove(Side memory d) internal pure returns (uint24) {
        return (d.shape >> 11) & MAX_WIDTH;
    }

    /// @notice Clear a side's rule but keep its edge (the position's range does not change).
    function clear(Side memory d) internal pure {
        int24 edge = d.edge;
        delete d.checker;
        delete d.value;
        delete d.checkPool;
        delete d.actions;
        delete d.removeBps;
        delete d.swapToToken1;
        delete d.addMode;
        delete d.repeat;
        delete d.shape;
        delete d.lastRun;
        delete d.checker2;
        delete d.value2;
        delete d.checkPool2;
        delete d.combine;
        delete d.holdMinutes;
        delete d.armedAt;
        delete d.best;
        delete d.runsLeft;
        d.edge = edge;
    }

    /// @dev Seconds to minutes since BASE_TIME, rounded up, so a stored time is never earlier than the real one.
    /// 0 stays 0 (never / not armed).
    function _minutes(uint32 t) private pure returns (uint256 m) {
        if (t == 0) return 0;
        if (t < BASE_TIME) revert TimeBeforeBase();
        m = (uint256(t) - BASE_TIME + 59) / 60;
        if (m == 0) m = 1; // exactly BASE_TIME: keep it distinct from "never"
        if (m > type(uint24).max) revert FieldTooLarge();
    }

    function _time(uint24 m) private pure returns (uint32) {
        return m == 0 ? 0 : uint32(BASE_TIME + uint256(m) * 60);
    }

    function _bit(bool b) private pure returns (uint256) {
        return b ? 1 : 0;
    }
}
