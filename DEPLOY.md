# Deploying Alucard (free)

| Piece | Where | Cost |
|---|---|---|
| Frontend (`frontend/`) | Vercel, Hobby plan | free |
| Backtest API (`frontend/api/backtest.py`) | the same Vercel project (Python function) | free |
| Keeper bot (`frontend/scripts/keeper.ts`) | GitHub Actions schedule (`.github/workflows/keeper.yml`) | free (public repo; private: 2,000 min/month) |
| Arbitrage bot (`frontend/scripts/arb.ts`) | your machine (`npx tsx scripts/arb.ts --keep` also runs the keeper) | test tokens and Sepolia gas |
| Contracts | on Sepolia and Unichain Sepolia (`deployments/`); steps in section 5 | testnet gas only |

Keys live only in git-ignored files (`.env`, `frontend/.env.local`) or in the hosts' secret settings.

## 0. The code

The repository is github.com/Ronnieraj37/alucard. `frontend/api/_data/` (~23 MB of swap history) is committed: the
backtest needs it.

## 1. Vercel (frontend + backtest)

1. vercel.com, New Project, import the GitHub repo.
2. **Root Directory: `frontend`**. Framework preset: Next.js (detected).
3. Environment variable (Production and Preview): `NEXT_PUBLIC_RPC_URL` = your Alchemy Sepolia URL
   (`https://eth-sepolia.g.alchemy.com/v2/<key>`). Event logs (your positions, your limit orders) are read from a public
   Sepolia node in 50,000-block chunks, because free Alchemy keys answer only 10 blocks per log query; set
   `NEXT_PUBLIC_LOGS_RPC_URL` to use another node.
4. Deploy. Vercel builds the Next.js app and, from the same folder, the Python function `api/backtest.py`
   (`requirements.txt` installs numpy; `vercel.json` bundles `api/_data` and allows 60 s per request).
5. Check after the first deploy:
   - `https://<your-app>.vercel.app/api/backtest` answers `{"ok":true,"pools":[...]}`
   - Pool, New position, turn on "Add a strategy", pick a template, **Backtest**: results appear in about a second.
6. In the Alchemy dashboard, restrict the key to your Vercel domain (it is visible in the browser).

Every push to the main branch redeploys. After a new contract deployment: `cd frontend && npm run sync`, commit, push.

## 2. Keeper bot (GitHub Actions)

Off until you switch it on.

1. GitHub repo, Settings, Secrets and variables, Actions:
   - Secret `KEEPER_PRIVATE_KEY`: the deployer key for now (`PRIVATE_KEY` in `.env`).
   - Secret `SEPOLIA_RPC_URL`: an RPC URL (the Alchemy URL works; a separate server-side key is better).
   - Variable `KEEPER_ENABLED` = `true`.
2. It runs every 5 minutes (GitHub sometimes starts late). Actions tab: logs, and "Run workflow" to run it now.
3. Private repo: change the cron in `.github/workflows/keeper.yml` to `*/15 * * * *` or slower.

Try it locally without sending anything: `cd frontend && DRY_RUN=1 npx tsx scripts/keeper.ts`

## 3. Arbitrage on the test pools

A strategy step runs only while its pool is within `PriceFeeds.maxDeviationTicks` (200, ~2%) of Chainlink. On mainnet
arbitrageurs keep pools there; on Sepolia nobody does, so run the bot on your machine:

```bash
cd frontend
PRIVATE_KEY=0x... npx tsx scripts/arb.ts --keep          # every 60 s: pools onto Chainlink, then the keeper
PRIVATE_KEY=0x... npx tsx scripts/arb.ts --once          # one round
```

It trades with the deployer's test tokens (the faucet gives more). `scripts/demo-orders.ts` adds a few example strategies
in tight ranges, so real ETH moves trigger them while the bot runs.

## 4. Verify the contracts on Etherscan (optional)

```bash
set -a; source .env; set +a
PM=0xE03A1074c86CFeDd5C142C4F04F1a1536e203543
FEEDS=0x0e3f6F323727E8db4513cAC1667a659ED902F67a; HOOK=0x26Cc9Dff279Cb44193B9010fBFAcd998C1a090c0
RULES=0x36dD90fcB4c0208b20800CA53d6622293D4f7389; ORDERS=0x9909261057eE2165aA9a2317b960Aa51812D04B3
forge verify-contract --chain sepolia --watch $FEEDS src/PriceFeeds.sol:PriceFeeds \
  --constructor-args $(cast abi-encode "constructor(address)" $(cast wallet address --private-key $PRIVATE_KEY))
forge verify-contract --chain sepolia --watch $HOOK src/RuleHook.sol:RuleHook \
  --constructor-args $(cast abi-encode "constructor(address)" $PM)
forge verify-contract --chain sepolia --watch $RULES src/Rules.sol:Rules \
  --constructor-args $(cast abi-encode "constructor(address,address,address)" $PM $HOOK $FEEDS)
forge verify-contract --chain sepolia --watch $ORDERS src/ConditionalOrders.sol:ConditionalOrders \
  --constructor-args $(cast abi-encode "constructor(address,address)" $PM $RULES)
```

## Local development

```bash
cd frontend
npm install
npm run setup:api     # once: Python venv with numpy for the backtest API
npm run dev:api       # terminal 1: backtest API on 127.0.0.1:8787
npm run dev           # terminal 2: app on localhost:3000 (forwards /api/backtest to terminal 1)
```

## The backtest

- **Our pools** (the default, "This pool"): built at request time from the chain: every round of the two tokens'
  Chainlink feeds (via `PriceFeeds`, read with Multicall3 `eth_call`s), the pool's fee tier, and the arbitrage trades
  that keep the pool on that price. `frontend/api/_chain.py`; the pool list is `api/_data/deployment.json`, written by
  `npm run sync`. Optional Vercel variable `RPC_URL` (server-side); otherwise `NEXT_PUBLIC_RPC_URL`, then a public node.
  Checks: `cd frontend && .venv/bin/python -I api/test_chain_history.py`.
- **Mainnet data**: every swap of mainnet ETH/USDC 0.30% (96k) and 0.05% (1M), 2026-04-05 to 2026-10-03, exported from
  the separate `lp_study` research code by `export_backtest.py` into `frontend/api/_data/*.npz`.
- **Engine**: `frontend/api/_engine.py` (numpy only) decodes the exact words `createOrder` would get and runs them the
  way `ConditionalOrders.sol` does: conditions on the pool's price, holds, keeper delay, remove, keeper
  reserve, kept or paid-out fees, swap with slippage limit, re-add or follow, moves and the way back, repeat, close.
  Fees use lp_study's validated swap replay.
- **Checks**: `forge test --match-contract EditorParity` (the engine runs 2,000 random orders exactly where the contract
  does) and `frontend/api/test_chain_history.py`.
- **Newer dates**: rerun `lp_study/fetch.py` for a new window, then `export_backtest.py`, commit, push.
- **Caching**: requests are GETs. Mainnet history never changes: a one-year CDN cache. Our pools: one hour.

## 5. Deploying the contracts

A full deploy is a new token list, a new hook (pools belong to a hook, so new pools), `Rules` and `ConditionalOrders`. The
test tokens and the faucet stay. Every contract is under the 24,576-byte limit, so the same scripts work on Unichain.

| Script | Deploys |
|---|---|
| `script/sepolia/02_DeployCore.s.sol` | `PriceFeeds` (lists ETH and the six test tokens on Chainlink's Sepolia feeds; USDT gets a fixed $1 mock, reused if one exists; band 200 ticks), `RuleHook` at a mined address, `Rules`, `ConditionalOrders`. Writes `deployments/sepolia-core.json` |
| `script/sepolia/03_CreatePools.s.sol` | the pools at today's Chainlink prices with the deployer's liquidity, each registered in `Rules`; an existing hookless pool is reused. Writes `deployments/sepolia-pools.json` |

Chainlink feeds used (Ethereum Sepolia): ETH / USD `0x694AA1769357215DE4FAC081bf1f309aDC325306`, BTC / USD
`0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43`, LINK / USD `0xc59E3633BAAC79493d908e63626716e204A45EdF` (1 h heartbeat);
USDC / USD `0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E`, DAI / USD `0x14866185B1962B63C3Ea9E03Bc1da838bab34C19` (24 h).

1. Rehearse on a local fork (nothing is sent to Sepolia; the real `deployments/` files are not touched):
   ```bash
   set -a; source .env; set +a
   anvil --fork-url $SEPOLIA_RPC --port 8546        # terminal 1
   script/sepolia/rehearse-fork.sh                  # terminal 2
   ```
   It deploys into `deployments/fork/`, gives every token a mock Chainlink feed (`ForkMarket.s.sol`, through the
   2-day timelock), points the frontend at the fork, then runs `check-rules` (every template against the contract) and
   `e2e-fork` (the market moves, `arb.ts` follows, the keeper runs: pushes alone fire nothing, holds wait, moves go
   out and come back). To click through the app against the fork: `NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8546
   NEXT_PUBLIC_LOGS_RPC_URL=http://127.0.0.1:8546 NEXT_DIST_DIR=.next-fork npx next dev -p 3107`.
2. Real deploy (Sepolia charges far more gas for contract code than forge estimates locally, hence the multiplier):
   ```bash
   forge script script/sepolia/02_DeployCore.s.sol --rpc-url $SEPOLIA_RPC --broadcast --private-key $PRIVATE_KEY --gas-estimate-multiplier 1000
   forge script script/sepolia/03_CreatePools.s.sol --rpc-url $SEPOLIA_RPC --broadcast --private-key $PRIVATE_KEY --gas-estimate-multiplier 1000
   ```
3. `cd frontend && npm run sync` (back to the real `deployments/`; it writes every chain it finds), then
   `CHAIN=sepolia APPROVE=1 npx tsx scripts/check-rules.ts` (the deployer approves the new vault, every template is
   dry-run against it) and `npx tsx scripts/arb.ts --once` so every pool
   (an older hookless one too) starts on Chainlink. Commit, push.

### Unichain Sepolia

The same scripts (they pick files and Chainlink feeds by chain id: `script/sepolia/Net.sol`). Your Sepolia Alchemy URL
works there with the network swapped. Gas is a fraction of a cent, so no multiplier is needed:

```bash
set -a; source .env; set +a
U=${SEPOLIA_RPC/eth-sepolia/unichain-sepolia}
for s in 01_DeployTokens 05_DeployFaucet 02_DeployCore 03_CreatePools; do
  forge script script/sepolia/$s.s.sol --rpc-url $U --broadcast --private-key $PRIVATE_KEY
done
cd frontend && npm run sync
CHAIN=unichain APPROVE=1 npx tsx scripts/check-rules.ts && CHAIN=unichain npx tsx scripts/arb.ts --once
```

01 and 05 only once per chain (tokens and faucet are reused). On Vercel, `NEXT_PUBLIC_UNICHAIN_RPC_URL` is optional: by
default the app uses the Sepolia Alchemy URL with the network swapped (allow both networks for the key in Alchemy).

Admin calls on `PriceFeeds` (owner only): `setFeed(token, aggregator, maxAge)` lists a new token at once; changing or
removing a listed one is announced with `queueFeed(token, aggregator, maxAge)` (aggregator 0 removes) and applied with
`setFeed` two days later. The band (how far a pool's price may be from Chainlink: `setMaxDeviationTicks`, 200 ≈ 2%, and
`setPairBand` for a tighter pair, 50 for two stablecoins) and the optional L2 sequencer feed (`setSequencer`) are set by
`02_DeployCore`, which then calls `lockBands`: from then on every change is announced with `queueBand` / `queueSequencer`
and applied two days later. `transferOwnership` then `acceptOwnership` hands the list over.

Earlier deployments (their orders can be cancelled there): before the 2026-11-28 guard update, ConditionalOrders
`0xa653D69C934B431431C11e55a59bbf69e524Db3c` on Sepolia and `0xb190f93B9511B40c12F068b9bdd2d392aBAC3FBD` on Unichain
Sepolia; on Sepolia also `0x6CD66E4c91635E2C7705fa2CE61Ac6df24cb12d3` (before the 2026-11-27 review fixes), `0xfCde70E4Ec35C79CD025306ff26AE1dEfFe72408` (average-price version), `0x05c6f35e2F12eFc54F26b26CE16A6226Ac74B6bC`; v1
ConditionalOrders `0x4F2B3Af637Bd20D56D4238033f23a4c1CE381D63` (RuleHook `0x9D4E651bb9a27a9b1406151b3f12Bb1a61B090c0`).
