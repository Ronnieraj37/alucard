# Roadmap: discussed and agreed

**Agreed for the hookathon (final submission Thu 3 Dec):** items 1 to 4, in that order. Items 5 to 7 are proposals from the LP
research below, to confirm. Everything under "Later" waits until after the submission. Nothing here is built yet.

Theme: Uniswap Hookathon Theme, Active Management and Curated Liquidity. Alucard sits in the active-management half
(auto-rebalance via signals and oracles; backtesting and strategy migration). Curator features are out: that space is crowded.

## Why: most Uniswap liquidity sits idle

- Across Uniswap v3-style pools, a 2026 Dune study (Jan to Jun, 7 chains) found only **13.7%** of concentrated liquidity was
  touched by a week's trades; **56.9%** was in range but unused, and **29.4%** was out of range (25-35% most weeks, up to ~41%).
  **44.5%** of the out-of-range capital on Uniswap v3 had been dormant for 90 days, and **82-94%** of it belonged to individual
  wallets, not managers. (Secondary coverage in The Block and CoinDesk; the original report not yet checked.)
- About half of v3 LPs earned less in fees than they lost to impermanent loss, and LPs who rebalanced by hand increased their
  losses on average (academic studies of v3, cited by Nasdaq and on arXiv).
- So the product's job is to put idle Uniswap liquidity back to work **inside Uniswap**, on positions people already hold, and to
  show plainly whether a position is beating simply holding.

## 1. Rules that repeat correctly (fix first)

**Problem.** Price conditions are fixed levels (for example "WETH below $2,150"). On a repeat the contract shifts the level by a
fixed step, so a rule can never re-anchor to wherever the price is after it ran. With and/or, the two conditions re-arm
differently after a run (a second price level steps, a timer resets, a trailing condition keeps its own high), and several
or + repeat combinations are refused, so rules drift out of sync.

**Build.**
- New condition: **price moves X% from the anchor.** The anchor is the price when the rule is armed and resets to the price at
  each run, so every repeat means "the next X% from where it last acted", for any pair, with no hard-coded token prices.
- One shared re-arm step for both conditions after a run, so and/or behaves the same on every repeat.
- Keep absolute levels for people who want a fixed price.
- Editor, backtest engine, parity tests and docs updated together.

## 2. Pool APR condition

- Condition: **the pool's fee APR over the last N days is above / below Y%** (N from 1 day to 1 year).
- Measured on-chain: snapshot the pool's running fee totals (feeGrowthGlobal) and turn the change into an APR. No outside data.
- Also: **my position vs holding the deposit over N days** (fees minus impermanent loss), shown on the position and usable as a
  condition ("if my position trails holding by X% over N days, act").

## 3. Move to another pool (same protocol)

- Action: exit the position and re-add it, in one transaction, to another pool Alucard manages, or to the same pool with a new
  range (re-range, compound).
- Target pools must be on the list (listed tokens; no hook or a known hook). Swap slippage is checked against Chainlink.
- Example: "if WETH falls 10%, move to the USDC/USDT pool; move back after a recovery." With item 2: "if this pool's APR falls
  below Y% for N days, move to the pool where it is higher."
- Backtest across pools needs swap history for the destination pool.

## 4. Move to and from other Uniswap pools (v3, and v4 pools without our hook)

- **Rules on positions people already hold.** Most liquidity is not in Alucard's pools, so rules must work where it is.
- **Uniswap v4 pools with no hook:** Alucard adds and removes liquidity through the PoolManager and keepers check conditions, so
  these pools work without our hook. Without it, the same-transaction swap guard is gone, so the contract checks the pool price
  against Chainlink instead. Small effort (hookless pools are already registered).
- **Uniswap v3 pools:** a separate adapter that mints, burns and collects v3 position NFTs. Users bring an existing v3 position by
  approving or transferring the NFT, then attach rules to it. Move works across all three (Alucard pool, hookless v4, v3).
  Medium effort.
- Limit orders filled inside swaps stay a feature of Alucard's own pools only.
- Other DEXes are out of scope: the product stays Uniswap-only.

## 5. Proposed: a position page that tells the truth (to confirm)

- Net result, fees earned, impermanent loss and **result vs holding**, from deposit to now; time in range.
- Expected keeper cost per run and the fees needed to break even, shown before a re-range or compound rule is turned on (manual
  rebalancing lost money on average because its costs were not counted).
- A range-width preview from the backtest: how fees and impermanent loss change as the range narrows.

## 6. Proposed: wake idle positions (to confirm)

- Detect positions out of range or untouched for N days and offer a ready rule in one click (re-range, Move, or exit).
- Alerts (Telegram or email) when a position goes out of range or a rule runs.

## 7. Proposed: park inside Uniswap, not outside it (to confirm)

- Lending idle funds to Aave takes liquidity out of Uniswap, so it is out. Instead, a rule action that keeps idle tokens working
  in Uniswap: a one-sided range just past the price (it fills like a limit order and earns the fee when the price returns), a
  stable pool, or Alucard's own limit-order buckets.

# Later (after the submission)

## Leverage for LP positions (loans and the lending vault)

**Model.** A user deposits $200 of ETH + USDC; Alucard lends up to 2x their own money ($400), so a $600 position goes into the
pool. The loan never reaches a wallet: it is borrowed and added to the position in the same transaction, and every rule
(exit, re-range, compound, Move) runs on the whole position.

**Rules of the loan.**
- Borrow at most 2x own money; only listed tokens and pools; a cap per pool.
- Borrow both tokens in the deposit's own ratio (the debt then behaves like holding those tokens).
- Borrow only when the position is created; repeats never borrow again.
- Minimum range width for leveraged positions (to be set from the backtest).
- **Repayment in kind:** the vault accepts either token at the Chainlink price, so exits do not pay swap fees. In the backtest
  this was the difference between +15 and -13 bp a day at 3x.
- Any exit repays first, then the owner gets the rest. Compounding can reinvest or repay.

**Safety comes from rules, not from an APR check.**
- De-lever rules: exit when the price leaves the range, trailing stop, health floor.
- Liquidation is a rule any keeper can run: equity measured with Chainlink (not the pool price); below about 10% of the
  position, the keeper closes it, repays the vault and earns a bonus.
- Optional gate: keep leverage only while the position has beaten holding by more than the interest over the last N days.

**Where leverage made sense in the backtest** (real mainnet swaps, 6 months, one trade a day):
- ETH/USDC 0.30%, thin +-0.5% range, exit at the range edge, in-kind repay: about +15 to +17 bp a day at 3x vs +7 to +10 bp
  at 1x; worst day -2.4%.
- ETH/USDC 0.05%: lost at every leverage, even 1x (too much LP competition). Stable pools (USDC/USDT 0.01%): fees about 1-2% a
  year, below any realistic borrow rate.
- Busy days were worse, not better (busy means the price moves). Re-opening a range after every exit lost 63-100% at 2-3x.
- Gas not counted: only viable on cheap chains or large positions.

**Product stance.** Show the edge before anyone borrows ("this setup lost money over the last 30 days; leverage would have made
it worse"), and only allow leverage with de-lever rules attached.

### Where the loans come from: the lending vault

- One vault per lendable token (USDC, WETH). Deposit and receive a share token that grows as borrowers pay interest.
- Optional front door: deposit any listed token; it is converted through Alucard's own pools.
- Interest rate rises as more of the vault is lent out. A small protocol cut builds a bad-debt reserve.
- In-kind repayments are converted back using Alucard's own limit orders, which fill inside other people's swaps and earn a fee
  instead of paying one.
- Lenders' risk: bad debt if a liquidation is too late. Mitigated by early liquidation, per-pool caps and the reserve.
- Separate contract (ConditionalOrders is already 35 KB). Funded by the protocol first; open to outside lenders later.

### Before building leverage

- Re-run the leverage backtest on other pools and other periods (one 6-month window, ETH falling, one daily strategy so far).
- Add leverage to the in-app backtest: borrow amount, borrow rate, in-kind repay, de-lever rules, liquidations.

## Also later

- Hidden rules: store only a hash of the rule and reveal it when it runs (commit-reveal), plus a private RPC by default. Fhenix
  (encrypted conditions) considered and not needed.
- AI strategy builder: describe a strategy in words, get a rule set ready to backtest.
- Split ConditionalOrders under 24 KB for mainnet.
- Restyle the remaining app details (wallet-connected screens) and check them with a wallet.
