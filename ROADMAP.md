# Roadmap

Done in v2: moves into another pool and back, fee and fee-rate conditions, trailing stops, run limits, a price guard
against pushed prices, every contract under 24 KB.

Next, all about more options for LPs (Alucard runs the strategies people bring; it does not choose them):

- **Bring an existing position:** adopt a Uniswap v4 NFT position (or migrate a v3 one) instead of creating a new one.
- **Moves between pools with no token in common:** two swaps on the way (e.g. WBTC/WETH into USDC/USDT).
- **Moves into lending:** hold the token in an ERC-4626 vault while moved, not only in a pool or the PoolManager.
- **More conditions:** volatility, pool volume or liquidity, another pool's fee rate ("move to whichever pool pays more").
- **Backtests across pools:** swap history for the pool a move goes into, so its fees are counted.
- **Alerts:** Telegram or email when a step runs, or waits on the price guard.
- **AI strategy builder:** describe a strategy in words, get one ready to backtest.
- **Unichain deploy:** needs its Chainlink feed addresses; the contracts already fit.
- **Loans for LPs?** LPs can also trade, so give them more options: take a loan whose amount is used from a black box
  that can sit in any pool in any ratio, and lend right into the protocol.
