# Roadmap

Done: strategies of the LP's own (conditions, steps, repeats, holds), moves into another pool and back, fee and fee-rate
conditions, trailing stops, run limits, a Chainlink price guard against pushed prices, every contract under 24 KB, the
backtest on real mainnet swaps of the same pair (proven equal to the contract), the AI assistant in the builder, and
deployments on Ethereum Sepolia and Unichain Sepolia.

Next, all about more options for LPs (Alucard runs the strategies people bring; it does not choose them):

- **Audit and mainnet:** an external audit, then Unichain and Ethereum mainnet.
- **Bring an existing position:** adopt a Uniswap v4 NFT position (or migrate a v3 one) instead of creating a new one.
- **Tighter execution:** anchor a step's swap to Chainlink (not only the pool's price), a margin before money comes back
  (no push-in-push-out within the band), and a band per pair (narrower for stablecoins).
- **Backtest the price guard:** replay mainnet Chainlink rounds too, so steps the band would have delayed show as delayed;
  count fees in the pool a move goes into.
- **Moves between pools with no token in common:** two swaps on the way (e.g. WBTC/WETH into USDC/USDT).
- **Moves into lending:** hold the token in an ERC-4626 vault while moved, not only in a pool or the PoolManager.
- **More conditions:** volatility, pool volume or liquidity, another pool's fee rate ("move to whichever pool pays more").
- **Alerts:** Telegram or email when a step runs, or waits on the price guard.
