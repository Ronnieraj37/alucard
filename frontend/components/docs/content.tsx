"use client";

import { ArrowLeftRight, Bot, FlaskConical, Layers, LineChart, ShieldCheck, Sparkles, Target, Waypoints } from "lucide-react";
import { CHAIN_ID, CHAIN_LABEL, EXPLORER } from "@/lib/chain";
import Link from "next/link";
import { CORE, POOLS, TOKENS } from "@/lib/pools";
import { Callout, Cards, Code, Dev, Kbd, Section, Steps } from "./ui";
import { Architecture, BitMap, Decoder, RangeSides } from "./visuals";

const ES = `${EXPLORER}/address/`;
const A = ({ a }: { a: string }) => (
  <a href={`${ES}${a}`} target="_blank" rel="noreferrer" className="font-mono text-[12.5px]">
    {a.slice(0, 6)}…{a.slice(-4)}
  </a>
);

export type DocSection = { id: string; title: string; group: "guide" | "dev"; keywords: string; render: () => React.ReactNode };

export const SECTIONS: DocSection[] = [
  // ================================================================ guide
  {
    id: "overview",
    title: "What Alucard does",
    group: "guide",
    keywords: "intro overview hook uniswap v4 strategy automate move pool",
    render: () => (
      <Section id="overview" title="What Alucard does" lead="Your own strategy, running on your Uniswap v4 position. The money stays in Uniswap v4 until you withdraw.">
        <p>
          Providing liquidity means watching the price: when it leaves your range you stop earning, and you have to decide what to do. Alucard lets you write
          that decision down once, as a <strong>strategy</strong>, when you add liquidity: your own conditions and your own steps. When a condition comes true,
          the steps run on their own. Alucard does not pick a strategy for you or judge it; it gives you the parts and runs what you build.
        </p>
        <Cards
          items={[
            { icon: Sparkles, title: "Strategies on your liquidity", text: "Exit, swap, compound, follow the price, take profit in steps. Your conditions, your steps.", href: "#strategies" },
            { icon: Waypoints, title: "Move to another pool and back", text: "Move the whole position into any other pool sharing a token, or hold one token, and come back by your own rule.", href: "#strategies" },
            { icon: Target, title: "Limit orders", text: "Sell at a price you choose. Filled inside other people’s swaps.", href: "#limit-orders" },
            { icon: FlaskConical, title: "Backtests", text: "Replay real swap history with your strategy, exactly as the contract would run it.", href: "#backtest" },
            { icon: Bot, title: "Anyone can run a step", text: "No company in the middle. Whoever runs a step is paid the keeper fee you set, out of what the step moves.", href: "#keepers" },
          ]}
        />
        <Callout kind="warn" title="Testnet">
          Alucard runs on Ethereum Sepolia with test tokens (tWETH, tUSDC…) that anyone can mint. They have no value.
        </Callout>
        <Dev>
          <p>
            Four contracts. <code>RuleHook</code> is the Uniswap v4 hook (afterInitialize, beforeSwap, afterSwap): it fills limit orders inside swaps. <code>ConditionalOrders</code> holds positions that have a strategy, inside the PoolManager (owner = the contract, salt =
            order id). <code>Rules</code> holds the pool table (any pool of listed tokens) and does conditions, the Chainlink check, validation and price math. <code>PriceFeeds</code> is the Chainlink token list. Each stays
            under the 24 KB size limit. Source: <code>src/</code>, tests: <code>test/</code> (138 Foundry tests).
          </p>
        </Dev>
      </Section>
    ),
  },
  {
    id: "getting-started",
    title: "Getting started",
    group: "guide",
    keywords: "wallet connect sepolia faucet test tokens metamask",
    render: () => (
      <Section id="getting-started" title="Getting started" lead="Three minutes from zero to your first position.">
        <Steps
          items={[
            <>
              <strong>Connect a wallet</strong> (MetaMask or any browser wallet) with <Kbd>Connect</Kbd>. If it is on another network, the app offers to switch to
              Sepolia.
            </>,
            <>
              <strong>Get Sepolia ETH</strong> for gas from any public Sepolia faucet. Gas on Sepolia costs a tiny fraction of a cent.
            </>,
            <>
              <strong>Get test tokens</strong> with <Kbd>Faucet</Kbd> in the header (or <Kbd>Get test tokens</Kbd> on a new position): one transaction gives 100 tWETH, 5 tWBTC, 500,000 tUSDC, tUSDT and tDAI, and
              20,000 tLINK.
            </>,
            <>
              <strong>Try it</strong>: <Link href="/swap">swap</Link>, place a <Link href="/swap">limit order</Link>, or <Link href="/pool/new">add liquidity</Link> with a
              strategy.
            </>,
          ]}
        />
        <Dev>
          <p>
            The faucet is <code>TestFaucet.drip()</code> at <A a={CORE.faucet} />. It calls <code>mint(msg.sender, amount)</code> on each open-mint{" "}
            <code>TestToken</code>, so it works with any wallet (no batching support needed).
          </p>
        </Dev>
      </Section>
    ),
  },
  {
    id: "swap",
    title: "Swapping",
    group: "guide",
    keywords: "swap trade quote route slippage",
    render: () => (
      <Section id="swap" title="Swapping" lead="Trade between test tokens in Alucard’s pools.">
        <p>
          Type an amount and the app asks Uniswap’s quoter for the best price across the pools of that pair. When a pair has more than one pool you can pick
          the route; swaps in pools that use Alucard’s hook also fill limit orders and move the prices strategies watch. Swaps accept up to 0.5% slippage.
        </p>
        <Dev>
          <p>
            Quotes: Uniswap v4 <code>V4Quoter.quoteExactInputSingle</code> via <code>eth_call</code> (the quoter is not a view function). Swaps: hookmate
            router <code>swapExactTokensForTokens(amountIn, amountOutMin, zeroForOne, poolKey, hookData, receiver, deadline)</code> at <A a={CORE.swapRouter} />.
          </p>
        </Dev>
      </Section>
    ),
  },
  {
    id: "limit-orders",
    title: "Limit orders",
    group: "guide",
    keywords: "limit order sell price bucket fill claim cancel",
    render: () => (
      <Section id="limit-orders" title="Limit orders" lead="Sell a token when its price reaches a level you choose.">
        <Steps
          items={[
            <>
              On <Link href="/swap">Swap</Link>, switch to <Kbd>Limit</Kbd>, choose what to sell and the price (or tap +1%, +2%, +5%, +10%).
            </>,
            <>The app shows the exact price band your order sells in: one tick spacing, about 0.6% wide in a 0.3% pool.</>,
            <>When someone’s swap moves the price all the way through that band, your order is filled during their swap.</>,
            <>
              Claim the proceeds under <em>Your limit orders</em>. Until it fills you can cancel at any time.
            </>,
          ]}
        />
        <Callout kind="note">
          While the price is inside your band, your order is partly sold and earns pool fees. If the price turns back before crossing the whole band, the
          sale reverses. Only a full cross locks it in.
        </Callout>
        <Callout kind="tip" title="Very small orders">
          Orders below 0.1% of the pool’s active liquidity are not filled inside swaps: swappers are not paid for filling, so their extra gas is kept small (at
          most 3 fills per swap). Once crossed, anyone can fill them and is paid 0.1% of the order’s proceeds, in the token the order received.
        </Callout>
        <Dev>
          <p>
            Orders at the same price share one Uniswap position (a <em>bucket</em>: range <code>[tickLower, tickLower + spacing]</code>, salt{" "}
            <code>2^255 | epochId</code>). <code>afterSwap</code> walks the hook’s own tick bitmap between the ticks before and after the swap and removes every
            fully crossed bucket in one <code>modifyLiquidity</code>, keeping proceeds as ERC-6909 claims. Details in{" "}
            <a href="#limit-internals">Limit order internals</a>.
          </p>
        </Dev>
      </Section>
    ),
  },
  {
    id: "positions",
    title: "Adding liquidity",
    group: "guide",
    keywords: "add liquidity position range deposit nft plain",
    render: () => (
      <Section id="positions" title="Adding liquidity" lead="A normal Uniswap position, with an optional strategy.">
        <Steps
          items={[
            <>
              <Link href="/pool/new">New position</Link>: pick a pair and fee tier.
            </>,
            <>Set a range with a preset (±2%, ±5%, ±15%, full) or type the low and high price.</>,
            <>Type one amount; the other is filled in from the price and the range.</>,
            <>
              Leave <Kbd>Add a strategy</Kbd> off for a plain Uniswap position, or turn it on to build one.
            </>,
          ]}
        />
        <p>
          Plain positions are ordinary Uniswap NFTs in your wallet. Positions with a strategy are held by the Alucard contract for you; you can edit the
          strategy or withdraw everything at any time from <Link href="/pool">Pool</Link>.
        </p>
        <Dev>
          <p>
            No strategy: <code>PositionManager.modifyLiquidities</code> with <code>MINT_POSITION, SETTLE_PAIR, SWEEP</code> through Permit2. With one:{" "}
            <code>ConditionalOrders.createOrder(CreateParams)</code>, where the app sends liquidity plus <code>amount0Max/amount1Max</code> with 2% headroom.
          </p>
        </Dev>
      </Section>
    ),
  },
  {
    id: "strategies",
    title: "Strategies",
    group: "guide",
    keywords: "strategy rules condition trigger steps repeat side move another pool come back template take profit stop loss follow compound",
    render: () => (
      <Section id="strategies" title="Strategies" lead="Two sides: what happens if the price falls, and what happens if it rises. Each side is: when this is true, do these steps.">
        <RangeSides />
        <p>
          The builder shows the strategy as a flow: your position at the top, branching into the two sides, each a short chain of step cards read top to
          bottom. Click a step to open its settings; the <Kbd>+</Kbd> at the end of a side only offers what fits after the steps above it, and greys out
          the rest with the reason. The status chip in the top bar says the whole strategy in plain words, or what is left to fix. Or describe it to the
          assistant (<Kbd>⌘K</Kbd>): it asks back when something is missing, then fills in the same steps; nothing is signed until you save.
        </p>
        <h3>When: conditions</h3>
        <table>
          <thead>
            <tr>
              <th>Condition</th>
              <th>True when</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>Leaves my range</td><td>The price is past your range’s edge, optionally by an extra margin.</td></tr>
            <tr><td>Reaches a price</td><td>The price drops below (falls side) or rises above (rises side) a price you choose.</td></tr>
            <tr><td>Turns from its best price</td><td>A trailing stop: the price falls x% from its highest (or rises x% from its lowest) since the side started.</td></tr>
            <tr><td>Price in another pool</td><td>The same, watching another Alucard pool’s price.</td></tr>
            <tr><td>On a timer</td><td>A set time has passed since the side last ran.</td></tr>
            <tr><td>Fees earned</td><td>The fees since they were last collected reach x% of the position.</td></tr>
            <tr><td>Fee rate falls</td><td>Those fees, as a yearly rate, are below x% (after at least an hour).</td></tr>
          </tbody>
        </table>
        <p>
          Add <strong>a second condition</strong> (both, or either one), and <strong>only if it lasts</strong>: the condition must stay true for that many
          minutes in a row (up to a day) before the step runs, so a short wick does not count. Every price counts only while it is within about 2% of
          Chainlink&apos;s, so nobody can push a pool to fire a level more than ~2% from the real price, and any pool of listed tokens can be watched, with or without our hook.
        </p>
        <h3>Then: steps</h3>
        <table>
          <thead>
            <tr>
              <th>Step</th>
              <th>Effect</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>Move the money</td><td>Everything goes to another place until it comes back by itself: see below.</td></tr>
            <tr><td>Withdraw</td><td>Take some or all of the liquidity out to your wallet.</td></tr>
            <tr><td>Swap</td><td>Swap what was withdrawn into one token at once, never worse than your slippage limit.</td></tr>
            <tr><td>Follow the price</td><td>Move the whole position into a new range around the price (±x%), swapped to the mix it needs.</td></tr>
            <tr><td>Compound</td><td>Put earned fees back into the same range.</td></tr>
            <tr><td>Send fees to wallet</td><td>Fees go to you instead of staying in the position.</td></tr>
            <tr><td>Repeat</td><td>Run again the next time, optionally a set number of times; a price level steps after each run.</td></tr>
          </tbody>
        </table>
        <h3>Move to another pool, and back</h3>
        <p>A move takes everything out of your range and puts it somewhere else until your own condition brings it back:</p>
        <ul>
          <li>
            <strong>Into another pool</strong>: any Alucard pool that shares a token with yours, another pair or the same pair at another fee. The money is
            swapped into the shared token on the way and added in a range around that pool’s price (±% you choose).
          </li>
          <li>
            <strong>Hold one token</strong>: no pool; the token is kept for you inside the Uniswap PoolManager.
          </li>
          <li>
            <strong>Come back when</strong>: the price is back in your range (optionally a margin inside it), turns x% from its low or high, after a time, or at
            a price.
          </li>
          <li>
            <strong>Back into</strong>: the same range, or a new range of the same width around the price then. The position’s own sides start again.
          </li>
        </ul>
        <p>
          If both sides move the money, they share the same place and both ways back watch it, so each way back must not be true the moment the money arrives
          (the editor tells you when one would be).
        </p>
        <h3>Templates</h3>
        <p>
          Starting points, not advice: move to another pool while out of range, hold a token and come back on a turn, take profit, stop loss, trailing stop,
          auto re-range, compound, leave when fees dry up, take profit in steps, exit both ways. Everything stays editable.
        </p>
        <p>
          A strategy expires (30 days by default; set under Settings). When both sides have run and are off, the position closes and everything goes to your
          wallet.
        </p>
        <Dev>
          <p>
            In storage each side is one 256-bit slot; the UI’s “falls/rises” sides map to the contract’s lower/upper sides through the pool’s token order. A
            move is the order’s second leg (<code>Plan</code>): see <a href="#storage">Order storage</a> and <a href="#encoding">Encoding a strategy</a>.
          </p>
        </Dev>
      </Section>
    ),
  },
  {
    id: "keepers",
    title: "Who runs the steps",
    group: "guide",
    keywords: "keeper execute fee bot arbitrage",
    render: () => (
      <Section id="keepers" title="Who runs the steps" lead="A blockchain does nothing by itself: someone has to send the transaction.">
        <p>
          Anyone can run a step whose condition is true. The contract checks the condition again, checks that the pool&apos;s price is near Chainlink&apos;s,
          runs the steps, and pays the caller your <strong>keeper fee</strong>: a share of what the step moves (0.1% by default, at most 1%), in the
          position&apos;s own tokens, whatever the gas price. A fee of 0 is allowed: then you (or anyone kind) run it.
        </p>
        <p>
          Alucard runs a keeper bot every few minutes, and the <Link href="/keeper">Keeper</Link> page lets anyone run ready steps by hand.
        </p>
        <Dev>
          <Code lang="solidity">{`fee   = keeperFeeBps * (tokens the run removed)     // after a swap: of what the swap produced
paid  : to msg.sender, in the pool's two tokens; everything else to the owner`}</Code>
          <p>
            Bot: <code>frontend/scripts/keeper.ts</code>, scheduled by <code>.github/workflows/keeper.yml</code> or run with{" "}
            <code>scripts/arb.ts --keep</code>. It runs each ready step in its own transaction (the fee goes to the caller, so batching through a shared
            multicall would send it there), and pokes trailing stops and holds. Apps should add room to gas estimates: <code>lib/gas.ts</code> adds 30% or at
            least 150k (a limit fill can land between the estimate and the block).
          </p>
        </Dev>
      </Section>
    ),
  },
  {
    id: "backtest",
    title: "Backtesting",
    group: "guide",
    keywords: "backtest history replay results windows",
    render: () => (
      <Section id="backtest" title="Backtesting" lead="See what your strategy would have done on real history before you use it.">
        <p>
          In the editor, press <Kbd>Backtest</Kbd>. Every swap of the history you pick is replayed against your position and strategy, the way the contract
          would run it (the engine takes the exact words the contract would store). Two kinds of history:
        </p>
        <ul>
          <li>
            <strong>This pool</strong> (the default): the last six months of your pool&apos;s price, from every round of its two tokens&apos; Chainlink feeds,
            read from the chain when you press the button, with the pool&apos;s own fee tier. Works for every pool on the token list, new ones included. A
            testnet pool has almost no traders, so the swaps are the arbitrage trades that keep it on the Chainlink price: fees are a lower bound.
          </li>
          <li>
            <strong>Mainnet ETH/USDC</strong>: every real swap of Ethereum&apos;s ETH/USDC pools (5 April to 3 October 2026: 96 thousand swaps in the 0.30%
            pool, 1 million in the 0.05% pool), with real traders and real fees. For other pairs, your range and triggers are scaled to ETH&apos;s price path.
          </li>
        </ul>
        <ul>
          <li>
            <strong>Shown next to:</strong> the same position without a strategy, and simply holding the tokens. The numbers are for you to judge; Alucard
            does not rate strategies.
          </li>
          <li>
            <strong>Every 30-day window</strong> repeats the test from each week’s start, so one lucky or unlucky period cannot mislead you.
          </li>
          <li>
            <strong>Costs counted:</strong> your keeper fee, swap fees and price impact of conversions.
          </li>
        </ul>
        <Callout kind="warn" title="What a backtest cannot tell you">
          The past does not predict the future. Your own swaps do not move later prices in the replay, and price manipulation and MEV are not modelled.
          While the money is moved into another pool, the replay counts it as the shared token: that pool’s fees are not included.
          On your own pool, ordinary traders are missing, so fees are understated; on mainnet ETH/USDC, other pairs use ETH’s price path.
        </Callout>
        <Dev>
          <p>
            Runs on the server, not in your browser: see <a href="#backtest-api">Backtest API</a>.
          </p>
        </Dev>
      </Section>
    ),
  },
  {
    id: "safety",
    title: "Safety and limits",
    group: "guide",
    keywords: "safety security manipulation flash loan slippage expiry payout withdraw chainlink pushed price",
    render: () => (
      <Section id="safety" title="Safety and limits" lead="What protects your position, and what to be aware of.">
        <Cards
          items={[
            { icon: ShieldCheck, title: "Prices Chainlink agrees with", text: "A pool's price counts only while it is within about 2% of Chainlink's. Pushing a pool to fire someone's strategy means pushing it away from Chainlink, and then it does not count, however long it is held." },
            { icon: ArrowLeftRight, title: "Nothing runs at a pushed price", text: "Before any step, and before entering another pool, the price must be near Chainlink's. Swaps stop at your slippage limit." },
            { icon: Layers, title: "Payouts are never stuck", text: "If a transfer to you fails (e.g. a contract wallet that refuses ETH), it is held for you to withdraw to any address." },
            { icon: LineChart, title: "Always yours", text: "Withdraw everything at any time, wherever the money is. After expiry anyone can close it, and the tokens still go to you." },
          ]}
        />
        <Callout kind="warn">
          Not audited. No upgrades. The only admin is the token list (which tokens have a Chainlink price): its changes wait two days, and its owner can set
          how far a pool may be from Chainlink for steps to run. Testnet only.
        </Callout>
        <Dev>
          <p>
            <code>Rules.tickOf</code> reads a pool&apos;s tick and says whether it is within <code>PriceFeeds.maxDeviationTicks</code> (200 on Sepolia) of{" "}
            <code>PriceFeeds.pairTick</code>. Pool conditions are only true with such a price; <code>Rules.checkPrice</code> reverts{" "}
            <code>PriceMoved</code> before every step and before entering another pool otherwise, and with no Chainlink price at all. No price history
            is kept: swaps pay nothing for strategies. A side runs at most once a minute (<code>MIN_GAP</code>). On Sepolia nobody arbitrages the test
            pools, so <code>frontend/scripts/arb.ts</code> does: it keeps every pool on Chainlink.
          </p>
        </Dev>
      </Section>
    ),
  },
  {
    id: "faq",
    title: "FAQ",
    group: "guide",
    keywords: "faq questions",
    render: () => (
      <Section id="faq" title="FAQ">
        <h3>Can I add a strategy to a position I already have?</h3>
        <p>Not yet. A position gets a strategy when it is created through Alucard. You can withdraw a plain position and create a new one with a strategy.</p>
        <h3>What happens if nobody runs a step?</h3>
        <p>It stays ready. When it runs later, the contract checks the condition again at that moment; if the price has moved back, it does not run.</p>
        <h3>Why does a ready step say it cannot run yet?</h3>
        <p>
          The pool&apos;s price is too far from Chainlink&apos;s (someone pushed it, or arbitrage has not caught up). It runs once they agree again. The position page shows the reason.
        </p>
        <h3>Can I change my strategy?</h3>
        <p>
          Yes. Open the position under <Link href="/pool">Pool</Link> and press <Kbd>Edit strategy</Kbd>. The liquidity and range stay. Where a move goes is
          fixed once created; while the money is moved, you can change when it comes back.
        </p>
        <h3>Which pools can a move go into?</h3>
        <p>Any Alucard pool that shares a token with yours. On mainnet that would be any pool with the hook; on Sepolia, the eight pools listed under Addresses.</p>
      </Section>
    ),
  },

  // ================================================================ developer
  {
    id: "architecture",
    title: "Architecture",
    group: "dev",
    keywords: "architecture contracts flow diagram hook conditionalorders poolmanager",
    render: () => (
      <Section dev id="architecture" title="Architecture" lead="Who calls what, and where the money is.">
        <Architecture />
        <table>
          <thead>
            <tr>
              <th>Contract</th>
              <th>Role</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>RuleHook</code>
              </td>
              <td>
                Hook with afterInitialize (numbers the pool for its limit orders), beforeSwap (notes the tick, in transient storage) and afterSwap (fills
                crossed limit buckets, at most 3). Limit orders: place, cancel, claim, fillBucket.
              </td>
            </tr>
            <tr>
              <td>
                <code>ConditionalOrders</code>
              </td>
              <td>
                Holds positions with a strategy, and the tokens of a move. createOrder, updateOrder, execute (anyone), poke (anyone), cancel, withdraw (held
                payouts).
              </td>
            </tr>
            <tr>
              <td>
                <code>Rules</code>
              </td>
              <td>The pool table (registerPool: any pool of listed tokens, hookless or ours). Is a condition true (met), is the price near Chainlink (checkPrice), is a strategy valid (checkSide, checkLegs), swap limits, ranges.</td>
            </tr>
            <tr>
              <td>
                <code>PriceFeeds</code>
              </td>
              <td>The token list: each token’s Chainlink feed (changes wait 2 days), and how far a pool may be from Chainlink.</td>
            </tr>
            <tr>
              <td>
                <code>OrderState</code>
              </td>
              <td>Library packing one side of a rule into one 256-bit word (one storage slot per side).</td>
            </tr>
          </tbody>
        </table>
        <h3>Life of an order</h3>
        <Steps
          items={[
            <>
              <code>createOrder</code> validates both sides, stores two slots, then <code>unlock</code> → <code>modifyLiquidity(salt = orderId)</code>; the owner settles
              the tokens.
            </>,
            <>
              A keeper sees <code>Rules.canExecute(vault, id, upper) == true</code> and calls <code>execute</code>; the contract asks <code>Rules.met</code>{" "}
              again (a price counts only near Chainlink&apos;s), checks a hold has lasted, then <code>Rules.checkPrice</code>.
            </>,
            <>
              Inside <code>unlockCallback</code>: remove → set the keeper fee aside → swap (optional) → add (optional) → update the side → close or store →
              pay keeper → pay owner.
            </>,
            <>When both sides are off or no liquidity is left, everything is removed and paid to the owner.</>,
            <>
              A side with the move bit takes everything out of the live leg (swapping into the shared token when the other leg is another pair), puts it into the
              other leg (held as ERC-6909 claims while waiting, or swapped to the range&apos;s mix and added), and swaps the legs: the one left keeps its sides
              for the way back.
            </>,
          ]}
        />
      </Section>
    ),
  },
  {
    id: "addresses",
    title: "Addresses",
    group: "dev",
    keywords: "addresses deployment sepolia etherscan pools tokens",
    render: () => (
      <Section dev id="addresses" title="Addresses" lead={`${CHAIN_LABEL} (chain id ${CHAIN_ID}); switch networks in the header for the other one. Source of truth: deployments/*.json.`}>
        <table>
          <thead>
            <tr>
              <th>Contract</th>
              <th>Address</th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["RuleHook", CORE.ruleHook],
                ["ConditionalOrders", CORE.conditionalOrders],
                ["Rules", CORE.rules],
                ["PriceFeeds", CORE.priceFeeds],
                ["TestFaucet", CORE.faucet],
                ["Uniswap PoolManager", CORE.poolManager],
                ["Uniswap PositionManager", CORE.positionManager],
                ["Swap router (hookmate)", CORE.swapRouter],
                ["Permit2", CORE.permit2],
              ] as [string, string][]
            ).map(([n, a]) => (
              <tr key={n}>
                <td>{n}</td>
                <td>
                  <A a={a} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>Test tokens</h3>
        <table>
          <thead>
            <tr>
              <th>Token</th>
              <th>Decimals</th>
              <th>Address</th>
            </tr>
          </thead>
          <tbody>
            {TOKENS.filter((t) => !t.native).map((t) => (
              <tr key={t.symbol}>
                <td>t{t.symbol}</td>
                <td>{t.decimals}</td>
                <td>
                  <A a={t.address} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>Pool table</h3>
        <table>
          <thead>
            <tr>
              <th>Index</th>
              <th>Pool</th>
              <th>Spacing</th>
              <th>Hook</th>
            </tr>
          </thead>
          <tbody>
            {POOLS.map((p) => (
              <tr key={p.index}>
                <td>{p.index}</td>
                <td>
                  {p.token0.symbol} / {p.token1.symbol} · {p.key.fee / 10_000}%
                </td>
                <td>{p.key.tickSpacing}</td>
                <td>{p.hooked ? "RuleHook" : "none"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    ),
  },
  {
    id: "storage",
    title: "Order storage",
    group: "dev",
    keywords: "storage layout bits slot packing orderstate word side edge checker value checkpool combine hold trail memo runsleft",
    render: () => (
      <Section dev id="storage" title="Order storage" lead="Three storage slots per order: one written once, then one 256-bit word for each side of the rule.">
        <h3>Slot 0: written once</h3>
        <BitMap which="slot0" />
        <h3>Slots 1 and 2: one word per side</h3>
        <p>
          Slot 1 is the lower side (fires when the tick falls), slot 2 the upper side (fires when it rises, or on time). Each word holds everything its own
          check needs, so checking one side never reads the other. Every side has room for two conditions (A and B, joined by and / or), a hold, a trailing
          stop and a run limit.
        </p>
        <BitMap which="side" />
        <Callout kind="note">
          In code the struct fields are <code>uint8</code>/<code>uint16</code> (Solidity has no 6-bit type); <code>encodeSide</code> packs them to the widths above
          and reverts <code>FieldTooLarge</code> rather than letting a value spill into its neighbour. A fuzz test changes one field at a time and checks
          nothing else moves.
        </Callout>
        <h3>Decode a word</h3>
        <Decoder />
      </Section>
    ),
  },
  {
    id: "encoding",
    title: "Encoding a strategy",
    group: "dev",
    keywords: "encoding encoderules side lane orientation baseis0 tick price checker actions validate",
    render: () => (
      <Section dev id="encoding" title="Encoding a strategy" lead="How the editor’s cards become contract sides (lib/rules.ts).">
        <h3>Lanes and sides</h3>
        <p>
          The UI speaks in the base token’s price (“if WETH falls”). Ticks measure token1 per token0, so when the base token is token1 a falling base price is a
          rising tick. The app picks the base by a fixed ranking (USDC, USDT, DAI, WETH, ETH, WBTC, LINK: the earlier one is the quote).
        </p>
        <Code lang="ts">{`contractSide(pool, lane) = (lane === "up") === pool.baseIs0 ? "upper" : "lower"
// a "price in another pool" trigger uses the WATCHED pool's orientation
tick(price) = log(t1per0 * 10^(dec1 - dec0)) / log(1.0001),  t1per0 = baseIs0 ? price : 1 / price`}</Code>
        <h3>Blocks to fields</h3>
        <table>
          <thead>
            <tr>
              <th>Block</th>
              <th>Fields</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Leaves my range (+x%)</td>
              <td>
                <code>checker=1</code>, <code>value = ticks(x%)</code>; with repeating Follow, at least one spacing
              </td>
            </tr>
            <tr>
              <td>Price reaches P</td>
              <td>
                <code>checker=2</code>, <code>value = tick(P)</code>, <code>checkPool = 0</code>
              </td>
            </tr>
            <tr>
              <td>Price in pool #n reaches P</td>
              <td>
                <code>checker=2</code>, <code>value</code> = tick in pool n, <code>checkPool = n</code>
              </td>
            </tr>
            <tr>
              <td>Every h hours</td>
              <td>
                <code>checker=3</code>, <code>value = h × 60</code>
              </td>
            </tr>
            <tr>
              <td>Trailing stop (x%)</td>
              <td>
                <code>checker=4</code>, <code>value</code> = ticks for a move of x%; the best tick seen (near Chainlink) is kept in <code>best</code> and raised by <code>poke</code>
              </td>
            </tr>
            <tr>
              <td>Second condition (and / or)</td>
              <td>
                <code>checker2</code>, <code>value2</code>, <code>checkPool2</code> like condition A; <code>combine</code> 1 = and, 2 = or
              </td>
            </tr>
            <tr>
              <td>Only if it lasts m minutes</td>
              <td>
                <code>holdMinutes = m</code> (1–1,440): the condition must have been true since <code>armedAt</code> (set by the first <code>poke</code> that
                sees it true, cleared by one that sees it false) for m minutes
              </td>
            </tr>
            <tr>
              <td>Fees earned x% / fees dry up y% a year</td>
              <td>
                <code>checker=6</code>, <code>value = x × 100</code> (bps of the position); <code>checker=7</code> (lower side only, must leave),{" "}
                <code>value = y × 100</code>, from the fees since the last collection (at least an hour)
              </td>
            </tr>
            <tr>
              <td>Move the money</td>
              <td>
                bit 4 with remove 100% and keep fees (leaving a held token: bit 4 alone), always <code>repeat</code>; swap bit when it must sell into the shared
                token. The place goes in <code>CreateParams.away</code> (<code>LEG_RANGE</code> / <code>LEG_CENTERED</code> in a pool, <code>LEG_IDLE</code> to hold),
                its ways back in <code>awayLower</code> / <code>awayUpper</code>
              </td>
            </tr>
            <tr>
              <td>Withdraw x% / Send fees</td>
              <td>
                bit 1 (remove), <code>removeBps = x × 100</code>; “send fees” clears bit 0 (otherwise set)
              </td>
            </tr>
            <tr>
              <td>Convert to T</td>
              <td>
                bit 2, <code>swapToToken1 = (T is token1)</code>
              </td>
            </tr>
            <tr>
              <td>Compound / Follow (w%)</td>
              <td>
                bit 3, <code>addMode</code> 0 / 1; Follow also sets remove 100% and <code>shape</code> = ⌈ticks(w)/spacing⌉ (upper: bits 0–10, lower: 11–21)
              </td>
            </tr>
            <tr>
              <td>Repeat</td>
              <td>
                <code>repeat</code>; a repeating price level stores its step in <code>shape</code> (except with Follow, whose width is there); a run limit goes in <code>runsLeft</code>
              </td>
            </tr>
          </tbody>
        </table>
        <h3>Validation (Rules.checkSide and Rules.checkLegs)</h3>
        <ul>
          <li>Actions must include remove, keep-fees or add; swap and add together are rejected.</li>
          <li>A side that removes everything and adds nothing cannot repeat: nothing would be left to run on.</li>
          <li>TIME needs value &gt; 0; EDGE needs value ≥ 0; TICK and TRAIL may read any pool in the table. Checker 5 (the old Chainlink condition) is retired.</li>
          <li>A repeating TICK side without add needs a step; a re-centre needs remove 100% and both widths, and cannot repeat on a price level.</li>
          <li>Holds are at most a day. APR only on the lower side of a side that leaves.</li>
          <li>Moves need a second leg; a held-token leg only moves; a move into another pair must swap into the shared token; an edit keeps a way to the other leg.</li>
        </ul>
        <p>
          <code>scripts/check-rules.ts</code> encodes every template on every pool and dry-runs <code>createOrder</code> against the contract, and{" "}
          <code>test/EditorParity.t.sol</code> checks that the editor accepts exactly what the contract accepts (35,126 cases) and that the backtest engine runs
          orders exactly where the contract does (2,000 orders).
        </p>
      </Section>
    ),
  },
  {
    id: "execution",
    title: "Execution, step by step",
    group: "dev",
    keywords: "execute execution flow wouldrefire close reserve swap add",
    render: () => (
      <Section dev id="execution" title="Execution, step by step" lead="What ConditionalOrders._execute does, in order.">
        <Code lang="text">{`1  side off?                                  -> revert SideOff
2  ran less than a minute ago?                -> revert TooSoon
3  Rules.met: condition true? (prices count only near Chainlink)  -> else ConditionNotMet
3a a hold: true for holdMinutes since armedAt?                    -> else NotHeldLongEnough
3b Rules.checkPrice: the pool's price near Chainlink?             -> else PriceMoved
4  move bit? -> take everything out, swap, (checkPrice of the other pool), enter the other leg, swap legs
5  remove removeBps of liquidity; fees collected with it
6  keeper fee = keeperFeeBps of everything removed; fees not kept -> owner
7  swap (bit 2): all of one token, price limit = price before it -/+ maxSlippage*10
8  add (bit 3): same range, or re-centre: a new range around the price, swapped to its mix
9  side: lastRun = now; repeat ? (TICK without add: value += step) : clear
10 no liquidity left or both sides off -> remove the rest, delete
11 pay the keeper its fee, everything else to the owner`}</Code>
        <p>
          Payouts take the tokens to the contract first and then try to send them (ETH with a 30,000 gas stipend). If a send fails, the amount is recorded in{" "}
          <code>owed[owner][currency]</code> and the owner calls <code>withdraw(currency, to)</code>.
        </p>
      </Section>
    ),
  },
  {
    id: "limit-internals",
    title: "Limit order internals",
    group: "dev",
    keywords: "limit internals bucket epoch fee accounting bitmap backlog dust minfill cap",
    render: () => (
      <Section dev id="limit-internals" title="Limit order internals" lead="Buckets, fair fees, and why swappers never pay for dust.">
        <h3>Epoch (one fill cycle of one bucket)</h3>
        <Code lang="solidity">{`struct Epoch {
  uint128 liquidityTotal; uint128 proceeds0;           // slot 0
  uint128 proceeds1; uint24 poolIndex; int24 tickLower;
  bool sellToken0; bool filled; bool inBitmap;         // slot 1
  uint256 feePerLiq0; uint256 feePerLiq1;              // slots 2-3, Q128
}
struct Share { uint128 liquidity; uint128 debt0; uint128 debt1; }`}</Code>
        <p>
          Fees collected when someone joins or leaves are credited to the holders at that moment through a fee-per-liquidity counter and per-user debt (like
          Uniswap’s feeGrowth), so a newcomer never takes fees earned before they joined. Each fill amount sits in a slot that already holds data, so recording
          a fill rewrites slots (~2.9k gas) instead of creating them (~20k): about 69k gas per bucket filled inside a swap.
        </p>
        <h3>Anti-dust</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>MIN_FILL_BPS = 10</code>
              </td>
              <td>A bucket is filled inside swaps only if it holds ≥ 0.1% of the pool’s active liquidity.</td>
            </tr>
            <tr>
              <td>
                <code>MAX_FILLS_PER_SWAP = 3</code>
              </td>
              <td>At most ~210k gas of fills per swap (swappers are not paid for them); the rest wait in a per-pool backlog that the next swaps finish first.</td>
            </tr>
            <tr>
              <td>
                <code>fillBucket</code>
              </td>
              <td>Anyone fills a crossed bucket and is paid FILL_REWARD_BPS (0.1%) of what it received.</td>
            </tr>
          </tbody>
        </table>
      </Section>
    ),
  },
  {
    id: "backtest-api",
    title: "Backtest API",
    group: "dev",
    keywords: "backtest api engine python vercel numpy request response",
    render: () => (
      <Section dev id="backtest-api" title="Backtest API" lead="A Vercel Python function in the same project as the app.">
        <Code lang="http">{`GET /api/backtest?q=<base64url(JSON)>     # cached: a year for mainnet history, an hour for our pools
POST /api/backtest  (JSON body)            # same, not cached`}</Code>
        <Code lang="json">{`{
  "pool": "sepolia:<pool index>" | "eth_usdc_030" | "eth_usdc_005",
  "start": 1775347200, "days": 90,            // or "mode": "windows" (every 30-day window, weekly)
  "depositUsd": 10000,
  "range": { "loPct": -5, "hiPct": 5 } | { "full": true },
  "order": { "lower", "upper", "home", "away", "awayLower", "awayUpper" },  // the words createOrder gets
  "refTick": 0, "homeIndex": 1, "spacing": 60, "baseIs0": true,         // where the levels were made
  "keeperFeeBps": 10, "slippagePct": 1, "delaySec": 12
}`}</Code>
        <p>
          The engine (<code>frontend/api/_engine.py</code>, numpy only) decodes the order words and runs the contract’s steps on each recorded swap.
          Recorded pools are arbitraged to the market, so the Chainlink check always passes there. Price levels move with the history (a level x% from
          today stays x% from the start), mirrored when the history lists the tokens the other way round; re-centre widths keep their width in price on
          another fee tier. A keeper runs a set delay after a condition holds, at the price after that swap, and only if it still holds; a hold needs the
          condition true at every swap for its whole time. Fees follow lp_study’s validated
          replay:
        </p>
        <Code lang="text">{`fee earned on a swap = fee_LP × overlap_fraction × L_position / (L_pool + L_position)
overlap_fraction ∈ [0, 1]: share of the swap's input that traded inside your range`}</Code>
        <p>
          Our pools (<code>sepolia:&lt;index&gt;</code>, <code>frontend/api/_chain.py</code>): the pool and its tokens come from{" "}
          <code>api/_data/deployment.json</code> (written by <code>npm run sync</code>); each token&apos;s Chainlink feed from <code>PriceFeeds</code>; every
          round of both feeds is read with <code>eth_call</code> through Multicall3, so free RPC plans work. The pair&apos;s price after each round is the
          ratio of the two. An arbitrageur trades the pool to the edge of its fee band around that price; every unit of liquidity in range earns the same
          fee per move:
        </p>
        <Code lang="text">{`pool price after a round = Chainlink × (1 − fee)  if Chainlink rose past the band
                         = Chainlink / (1 − fee)  if it fell past it (no trade inside the band)
fee earned = L_position × overlap_fraction × Δ × fee / (1 − fee)
Δ = change of √P (token1 in) or of 1/√P (token0 in)`}</Code>
        <p>
          Data: <code>frontend/api/_data/*.npz</code>, exported by <code>lp_study/export_backtest.py</code>. Checks:{" "}
          <code>test/EditorParity.t.sol</code> (the engine runs 2,000 random orders exactly where the contract does, run for run) and{" "}
          <code>frontend/api/test_chain_history.py</code> (our pools: the pool stays in its fee band, fees match the trades and do not depend on the
          pool&apos;s size).
        </p>
      </Section>
    ),
  },
  {
    id: "reference",
    title: "Function reference",
    group: "dev",
    keywords: "functions abi events reference api createorder execute placelimit",
    render: () => (
      <Section dev id="reference" title="Function reference">
        <h3>ConditionalOrders</h3>
        <table>
          <tbody>
            {(
              [
                ["createOrder(CreateParams) payable → orderId", "Add liquidity with a strategy (sides as packed words, an optional second leg). Native ETH as msg.value; extra refunded."],
                ["updateOrder(id, UpdateParams)", "Owner only. New sides for where the money is now; range, liquidity, where a move goes and the side clocks unchanged."],
                ["execute(id, upper)", "Anyone. Runs one side if its condition holds."],
                ["poke(id, upper)", "Anyone. A trailing side remembers a better price; a side with a hold is armed (or disarmed)."],
                ["armedAt(id, upper) view", "When a side's condition was first seen true (0 = not now)."],
                ["cancel(id)", "Owner any time; anyone after expiry. Everything to the owner."],
                ["withdraw(currency, to)", "Collect payouts that could not be sent."],
                ["getOrder(id) / getPlan(id) / ordersOf(owner)", "Views for apps: the order (packed sides), its second leg, an owner's orders."],
                ["Rules.canExecute(vault, id, upper) / orderAmounts(vault, id) / poolState(index)", "Views for keepers and apps."],
                ["Rules.registerPool(key) → index / poolKeyAt(index)", "Anyone. Add a pool strategies can use (two listed tokens; no hook or the limit-order hook)."],
                ["Rules.tickOf(index) → (ok, tick)", "A pool's tick, and whether it is near Chainlink (what conditions read)."],
                ["Rules.checkPrice(key)", "Reverts PriceMoved unless the pool's price is near Chainlink's."],
                ["Rules.encode(side) / decode(word)", "Pack or unpack a side."],
                ["PriceFeeds.setMaxDeviationTicks(ticks)", "Owner. How far a pool's price may be from Chainlink for steps to run (0 = not checked, tests only)."],
              ] as [string, string][]
            ).map(([f, d]) => (
              <tr key={f}>
                <td>
                  <code>{f}</code>
                </td>
                <td>{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>RuleHook</h3>
        <table>
          <tbody>
            {(
              [
                ["placeLimit(key, tickLower, sellToken0, amount) payable → epochId", "Join or open the bucket at that price."],
                ["cancelLimit(epochId, to) / claimLimit(epochId, to)", "Before / after the fill."],
                ["fillBucket(key, tickLower, sellToken0) → reward", "Fill a crossed bucket no swap filled."],
                ["poolKeyAt(index) / poolIndexOf(poolId)", "The pools of this hook, numbered for their limit orders."],
              ] as [string, string][]
            ).map(([f, d]) => (
              <tr key={f}>
                <td>
                  <code>{f}</code>
                </td>
                <td>{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>Events</h3>
        <p>
          <code>OrderCreated · OrderExecuted · OrderMoved · OrderUpdated · OrderPoked · OrderClosed · PayoutHeld · Withdrawn</code> and <code>LimitPlaced · LimitCancelled · BucketFilled · LimitClaimed · FillRewarded · PoolRegistered</code>.
        </p>
      </Section>
    ),
  },
  {
    id: "local-dev",
    title: "Run it locally",
    group: "dev",
    keywords: "local development commands tests forge npm deploy",
    render: () => (
      <Section dev id="local-dev" title="Run it locally">
        <Code lang="bash">{`# contracts
forge test                                   # 138 tests (EditorParity needs the app installed below)

# app + backtest API
cd frontend && npm install && npm run setup:api
npm run dev:api        # terminal 1: Python API on 127.0.0.1:8787
npm run dev            # terminal 2: http://localhost:3000

# checks
npx tsx scripts/check-rules.ts               # encodings vs the live contract
DRY_RUN=1 npx tsx scripts/keeper.ts          # what the keeper would run`}</Code>
        <p>
          Deploying: <code>DEPLOY.md</code>. Contract deployment scripts: <code>script/sepolia/01–05</code> (Sepolia needs{" "}
          <code>--gas-estimate-multiplier</code>; see <code>deployments/README.md</code>).
        </p>
      </Section>
    ),
  },
];
