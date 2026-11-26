// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";

/// @title PriceMath: token amounts of a range, and value at a price
/// @notice Prices are Uniswap sqrt prices (Q64.96) of token1 per token0.
library PriceMath {
    uint256 internal constant Q96 = 1 << 96;

    /// @notice Tokens `liquidity` holds in the range [a, b] at price p (fees not included).
    function amountsFor(uint160 p, uint160 a, uint160 b, uint128 liquidity)
        internal
        pure
        returns (uint256 amount0, uint256 amount1)
    {
        if (p <= a) {
            amount0 = SqrtPriceMath.getAmount0Delta(a, b, liquidity, false);
        } else if (p >= b) {
            amount1 = SqrtPriceMath.getAmount1Delta(a, b, liquidity, false);
        } else {
            amount0 = SqrtPriceMath.getAmount0Delta(p, b, liquidity, false);
            amount1 = SqrtPriceMath.getAmount1Delta(a, p, liquidity, false);
        }
    }

    /// @notice `amount0` of token0 expressed in token1 at price p.
    function in1(uint256 amount0, uint160 p) internal pure returns (uint256) {
        return FullMath.mulDiv(FullMath.mulDiv(amount0, p, Q96), p, Q96);
    }

    /// @notice `amount1` of token1 expressed in token0 at price p.
    function in0(uint256 amount1, uint160 p) internal pure returns (uint256) {
        return FullMath.mulDiv(FullMath.mulDiv(amount1, Q96, p), Q96, p);
    }

    /// @notice How much of which token to sell so that holdings (h0, h1) match the mix the range [a, b] needs at
    /// price p. Ignores the swap's fee and price impact: the little that does not fit is paid back to the owner.
    /// @return zeroForOne true to sell token0 for token1
    /// @return amountIn how much to sell (0 = the mix already fits)
    function sellForRange(uint160 p, uint160 a, uint160 b, uint256 h0, uint256 h1)
        internal
        pure
        returns (bool zeroForOne, uint256 amountIn)
    {
        if (p <= a) return (false, h1); // the range is above the price: it takes token0 only
        if (p >= b) return (true, h0); // below the price: token1 only
        // the mix one unit of liquidity needs, both sides valued in token1
        (uint256 need0, uint256 need1) = amountsFor(p, a, b, 1e18);
        uint256 need0In1 = in1(need0, p);
        uint256 want1 = FullMath.mulDiv(in1(h0, p) + h1, need1, need0In1 + need1);
        if (h1 > want1) return (false, h1 - want1);
        return (true, in0(want1 - h1, p));
    }
}
