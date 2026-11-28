# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences, equally important:

- **Hookathon judges and the Uniswap team** (UHI11). They see many hooks in a short review. Their job: grasp what Alucard does in seconds, believe it is real and tested, and try it on Sepolia.
- **Liquidity providers on Uniswap v4.** They hold concentrated positions and cannot watch the price all day. Every LP has their own strategy. Their job: write it down once (exit, move to another pool and back, re-range, compound), replay it on history, and trust that it runs exactly as written, without handing over their funds.

## Product Purpose

Alucard runs the LP's own strategy on a Uniswap v4 position: conditions (pool price, another pool's price, time, fees earned, fee rate, trailing, true for N minutes) and steps (move everything into any other pool sharing a token and come back by the LP's own rule, withdraw, swap to one token, follow the price, compound, repeat). A price condition fires only when Chainlink agrees, so nobody can push a pool to fire a strategy; strategies work on any v4 pool of listed tokens. Any keeper can run a step on-chain when its condition holds and is paid the owner's keeper fee. The money stays inside Uniswap v4 until the owner withdraws. Alucard is not a strategy maker: it does not pick, rate or promise returns for strategies; it gives more options and runs them faithfully. Success: an LP builds their strategy in a minute, replays it on history, and it runs exactly as the replay said.

## Positioning

- The LP's strategy, not ours: conditions combine with AND/OR, ladders, repeats, moves between pools and back. More options, never advice.
- No central operator: anyone can execute; limits (price, slippage, fee cap, run count) are enforced on-chain.
- Backtest before committing: the backtest engine runs the same steps as the contract, checked run-for-run against it.
- A Uniswap v4 hook (RuleHook) that also fills limit orders inside the swap.

## Operating Context

- Ethereum Sepolia and Unichain Sepolia testnets (network menu in the header; the app follows the wallet); test tokens from the in-app faucet; MetaMask-style injected wallet.
- Screens: Swap and limit orders, Pool (positions, new position), strategy builder (a flow of step cards on a canvas: the position branching into "if it falls" and "if it rises"; a step's settings open on click; templates; an AI assistant that asks back and fills in the steps), Backtest, Keeper (anyone can run ready steps), Docs.
- Built for the Uniswap Hook Incubator hookathon (UHI11).

## Capabilities and Constraints

- Contracts: RuleHook, ConditionalOrders, Rules, PriceFeeds (Chainlink token list) on Sepolia and Unichain Sepolia; each under 24 KB.
- Backtest: every real mainnet swap of the same pair (ETH/USDC, WBTC/USDC, WBTC/WETH, USDC/USDT, DAI/USDC, LINK/WETH), or the pool's own Chainlink price path.
- Assistant: Gemini, server-side; produces only the editor's types, validated like a hand-built strategy; never signs.
- Stack: Next.js, wagmi/viem, Tailwind; Python (numpy) backtest function and a Gemini route on Vercel.
- Undecided: domain name (to be bought), mainnet launch, protocol fee.

## Brand Commitments

- The name **Alucard** is fixed. Everything else (tagline, colors, type, look) may change.

## Evidence on Hand

- 146 Foundry tests, 35,126 editor-vs-contract parity cases with 0 mismatches, 2,000 engine-vs-contract replays firing at the same swaps and ending within 0.1% of the same money (on the strategies that test covers), 10 engine tests, every template dry-run against both live deployments, end to end on both chains and on a fork.
- Live deployments on Ethereum Sepolia and Unichain Sepolia (addresses in `deployments/`).
- No users, testimonials, TVL or partners yet: never invent them.

## Product Principles

1. The money stays in Uniswap v4 until the owner withdraws; the contract, not a server, enforces every limit.
2. Say exactly what will happen, in plain words, before it happens.
3. Show the evidence (replays, tests) instead of claims. Never claim a strategy beats holding: the LP judges.
4. Honest numbers: label estimates and lower bounds as such.
