# Roadmap

Done: strategies of the LP's own (conditions, steps, repeats, holds), moves into another pool and back, fee and fee-rate
conditions, trailing stops, run limits, a Chainlink price guard (prices count only near Chainlink; a Chainlink price
condition; swaps anchored to Chainlink, a step waits rather than sell into a push; a tighter band for stablecoin pairs; every admin change behind
a 2-day wait; an optional L2 sequencer check), every contract under 24 KB, the backtest on real mainnet swaps of the same
pair (its steps fire at the same swaps as the contract, and, on the strategies that test covers, the money matches within 0.1%), the AI assistant in the
builder, your own "when" cards (any contract that answers true or false), and deployments on Ethereum Sepolia and
Unichain Sepolia.

Next, all about more options for LPs (Alucard runs the strategies people bring; it does not choose them):

- **Audit and mainnet:** an external audit, then Unichain and Ethereum mainnet.
- **A card gallery:** published strategies and "when" cards, with their backtests across rising, falling and sideways
  markets, and attestations from reviewers (in the spirit of ERC-7484) shown next to each card.
- **Bring an existing position:** adopt a Uniswap v4 NFT position (or migrate a v3 one) instead of creating a new one.
- **Private execution:** send keeper transactions through a private mempool, so nobody can trade just around them.
- **Backtest the price guard:** replay mainnet Chainlink rounds too, so steps the band would have delayed show as delayed;
  count fees in the pool a move goes into.
- **Moves between pools with no token in common:** two swaps on the way (e.g. WBTC/WETH into USDC/USDT).
- **Moves into lending:** hold the token in an ERC-4626 vault while moved, not only in a pool or the PoolManager.
- **More conditions:** volatility, pool volume or liquidity, another pool's fee rate ("move to whichever pool pays more").
- **Alerts:** Telegram or email when a step runs, or waits on the price guard.
