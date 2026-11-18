# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences, equally important:

- **Hookathon judges and the Uniswap team** (UHI11). They see many hooks in a short review. Their job: grasp what Alucard does in seconds, believe it is real and tested, and try it on Sepolia.
- **Liquidity providers on Uniswap v4.** They hold concentrated positions and cannot watch the price all day. Their job: set what should happen to a position (exit, re-range, convert, compound) once, check it against history, and trust that it runs when the condition holds, without handing over their funds.

## Product Purpose

Alucard lets an LP attach rules to a Uniswap v4 position: conditions (pool price, Chainlink price, time, fees earned, trailing stop, holding time) and actions (withdraw, convert to one token, re-add, follow the price, repeat). Any keeper can run a rule on-chain when its condition holds and is paid per run from the position, never above the owner's cap. The money stays in Uniswap the whole time. Success: an LP sets a rule in a minute, backtests it on their own pool's history, and it runs exactly as the backtest said.

## Positioning

- Rules instead of a fixed menu: conditions combine with AND/OR, ladders, repeats, convert-on-exit.
- No central operator: anyone can execute; limits (price, slippage, fee cap, run count) are enforced on-chain.
- Backtest before committing: the backtest engine runs the same steps as the contract, checked run-for-run against it.
- A Uniswap v4 hook (RuleHook) that also fills limit orders inside the swap.

## Operating Context

- Ethereum Sepolia testnet; test tokens from the in-app faucet; MetaMask-style injected wallet.
- Screens: Swap and limit orders, Pool (positions, new position), rule editor (node graph, templates, plain-words summary), Backtest, Keeper (anyone can run ready orders), Docs.
- Built for the Uniswap Hook Incubator hookathon (UHI11).

## Capabilities and Constraints

- Contracts: RuleHook, ConditionalOrders, PriceFeeds (Chainlink token list) on Sepolia. ConditionalOrders is 35 KB, Sepolia-only until split.
- Backtest: the pool's own Chainlink price history (arbitrage-only fees, a lower bound) or real mainnet ETH/USDC swaps.
- Stack: Next.js, wagmi/viem, React Flow, Tailwind; Python backtest function on Vercel.
- Undecided: domain name (to be bought), mainnet launch, protocol fee.

## Brand Commitments

- The name **Alucard** is fixed. Everything else (tagline, colors, type, look) may change.

## Evidence on Hand

- 130 Foundry tests, 79,682 editor-vs-contract parity cases with 0 mismatches, 4,000 engine-vs-contract replays identical, stress tests (300 batched exits, 536 random runs).
- Live Sepolia deployment (addresses in `deployments/`).
- No users, testimonials, TVL or partners yet: never invent them.

## Product Principles

1. Funds never leave Uniswap; the contract, not a server, enforces every limit.
2. Say exactly what will happen, in plain words, before it happens.
3. Show the evidence (backtests, tests) instead of claims.
4. Honest numbers: label estimates and lower bounds as such.
