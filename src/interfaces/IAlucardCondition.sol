// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title A "when" card: a condition anyone can write
/// @notice Register the contract with `Rules.registerCondition` to get its card number, then use it in a strategy as
/// condition type 8 (CHECK_EXTERNAL). Rules calls `isMet` read-only (staticcall) with at most 200,000 gas. Only a clean
/// `true` counts: a revert, running out of gas, or any other answer means "not now", so the step does not run.
/// The card only decides WHEN. What the step does, and every guard on it, stays with the vault.
interface IAlucardCondition {
    /// @param vault the ConditionalOrders contract (read the order with `getOrder(orderId)`)
    /// @param orderId the order asking
    /// @param upper which side asks: the upper side (the price rising) or the lower one
    /// @return true when the step may run now
    function isMet(address vault, uint256 orderId, bool upper) external view returns (bool);
}
