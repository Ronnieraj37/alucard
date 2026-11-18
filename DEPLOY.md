# Deploying Alucard (free)

| Piece | Where | Cost |
|---|---|---|
| Frontend (`frontend/`) | Vercel, Hobby plan | free |
| Backtest API (`frontend/api/backtest.py`) | the same Vercel project (Python function) | free |
| Keeper bot (`frontend/scripts/keeper.ts`) | GitHub Actions schedule (`.github/workflows/keeper.yml`) | free (public repo; private: 2,000 min/month) |
| Contracts | on Sepolia (`deployments/`): ConditionalOrders `0x4F2B3Af637Bd20D56D4238033f23a4c1CE381D63`, PriceFeeds `0x2bCb85a1EACB0DDb564A7b5481BbdB290933715e` | Sepolia gas only |

Keys live only in git-ignored files (`.env`, `frontend/.env.local`) or in the hosts' secret settings.

## 0. The code

The repository is github.com/Ronnieraj37/alucard. `frontend/api/_data/` (~23 MB of swap history) is committed: the
backtest needs it.

## 1. Vercel (frontend + backtest)

1. vercel.com, New Project, import the GitHub repo.
2. **Root Directory: `frontend`**. Framework preset: Next.js (detected).
3. Environment variable (Production and Preview): `NEXT_PUBLIC_RPC_URL` = your Alchemy Sepolia URL
   (`https://eth-sepolia.g.alchemy.com/v2/<key>`).
4. Deploy. Vercel builds the Next.js app and, from the same folder, the Python function `api/backtest.py`
   (`requirements.txt` installs numpy; `vercel.json` bundles `api/_data` and allows 60 s per request).
5. Check after the first deploy:
   - `https://<your-app>.vercel.app/api/backtest` answers `{"ok":true,"pools":[...]}`
   - Pool, New position, turn on rules, pick a template, **Backtest**: results appear in about a second.
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

## 3. Verify the contracts on Etherscan (optional)

```bash
set -a; source .env; set +a
PM=0xE03A1074c86CFeDd5C142C4F04F1a1536e203543
forge verify-contract --chain sepolia --watch 0x9D4E651bb9a27a9b1406151b3f12Bb1a61B090c0 src/RuleHook.sol:RuleHook \
  --constructor-args $(cast abi-encode "constructor(address)" $PM)
forge verify-contract --chain sepolia --watch 0x2bCb85a1EACB0DDb564A7b5481BbdB290933715e src/PriceFeeds.sol:PriceFeeds \
  --constructor-args $(cast abi-encode "constructor(address)" 0x02847D22C33f5F060Bd27e69F1a413AD44cab213)
forge verify-contract --chain sepolia --watch 0x4F2B3Af637Bd20D56D4238033f23a4c1CE381D63 src/ConditionalOrders.sol:ConditionalOrders \
  --constructor-args $(cast abi-encode "constructor(address,address,address)" $PM 0x9D4E651bb9a27a9b1406151b3f12Bb1a61B090c0 0x2bCb85a1EACB0DDb564A7b5481BbdB290933715e)
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

- **Data**: every swap of mainnet ETH/USDC 0.30% (96k) and 0.05% (1M), 2026-04-05 to 2026-10-03, exported from
  the separate `lp_study` research code by `export_backtest.py` into `frontend/api/_data/*.npz`.
- **Engine**: `frontend/api/_engine.py` (numpy only) runs the rules the way `ConditionalOrders.sol` does: conditions,
  keeper delay, remove, keeper reserve, kept or paid-out fees, swap with slippage limit, re-add or follow, repeat,
  close, and the WouldRefire refusal. Fees use lp_study's validated swap replay.
- **Checks**: in `lp_study`, `.venv/bin/python -m pytest tests/test_rules_backtest.py` (46 tests: fees equal
  lp_sim's replay to 1e-9, exits at the swap the contract implies, encoding equal to the frontend's for both token
  orders, repeats, value conserved, fee share never above the whole fee).
- **Newer dates**: rerun `lp_study/fetch.py` for a new window, then `export_backtest.py`, commit, push.
- **Caching**: requests are GETs, answered with a one-year CDN cache header; the history never changes, so a repeated
  backtest costs nothing.

## 4. Redeploying ConditionalOrders with the token list (Chainlink feeds)

RuleHook did not change, so keep it, its pools and its limit orders. `script/sepolia/06_DeployOrders.s.sol` deploys:

- `PriceFeeds`, the token list. The deployer owns it. It lists native ETH and the six test tokens with Chainlink's
  Sepolia USD feeds (addresses from docs.chain.link/data-feeds/price-feeds/addresses, Ethereum Sepolia):

  | Token | Feed | Address | Heartbeat |
  |---|---|---|---|
  | ETH, tWETH | ETH / USD | `0x694AA1769357215DE4FAC081bf1f309aDC325306` | 1 h |
  | tWBTC | BTC / USD | `0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43` | 1 h |
  | tLINK | LINK / USD | `0xc59E3633BAAC79493d908e63626716e204A45EdF` | 1 h |
  | tUSDC | USDC / USD | `0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E` | 24 h |
  | tDAI | DAI / USD | `0x14866185B1962B63C3Ea9E03Bc1da838bab34C19` | 24 h |
  | tUSDT | none on Sepolia | a `MockAggregator` fixed at $1, deployed by the script | - |

- a new `ConditionalOrders` that points at the existing hook and at `PriceFeeds`.

Orders in the old ConditionalOrders keep working there; their owners can still cancel them.

1. Rehearse on a local fork first (nothing is sent to Sepolia):
   ```bash
   set -a; source .env; set +a
   anvil --fork-url $SEPOLIA_RPC --port 8546 --code-size-limit 65536
   # in another terminal: back up deployments/sepolia-core.json, then
   forge script script/sepolia/06_DeployOrders.s.sol --rpc-url http://127.0.0.1:8546 --broadcast \
     --private-key <an anvil test key> --code-size-limit 65536
   cd frontend && npm run sync && RPC_URL=http://127.0.0.1:8546 PRIVATE_KEY=<the same test key> npx tsx scripts/e2e-fork.ts
   # (a fork left running for hours makes its frozen Chainlink prices look old: start a fresh one)
   # restore deployments/sepolia-core.json afterwards and run npm run sync again
   ```
2. Real deploy. ConditionalOrders is about 35 KB: over the 24 KB limit of Unichain and Ethereum mainnet, so this
   works on Sepolia only until the contract is split.
   ```bash
   forge script script/sepolia/06_DeployOrders.s.sol --rpc-url $SEPOLIA_RPC --broadcast --private-key $PRIVATE_KEY \
     --code-size-limit 65536 --gas-estimate-multiplier 1000
   ```
   Sepolia charges far more gas for contract code than forge's local estimate assumes, hence the multiplier: the
   node estimates about 55 million gas for ConditionalOrders (the block limit there is 200 million; the earlier 21 KB
   version used 33 million). After it, remove the fork rehearsal's `broadcast/06_DeployOrders.s.sol` log if one is
   left over, so only the real run is kept.
   The script rewrites `deployments/sepolia-core.json` (`conditionalOrders`, `priceFeeds`, `usdtMockFeed`).
3. `cd frontend && npm run sync`, commit, push.

Done on 2026-11-19 (ConditionalOrders `0x4F2B3Af637Bd20D56D4238033f23a4c1CE381D63`, PriceFeeds
`0x2bCb85a1EACB0DDb564A7b5481BbdB290933715e`, USDT mock feed `0x15C8A66A00421D24e7172bf8Cc8CA4E674b8d6E4`); the frontend is synced.

Admin calls on `PriceFeeds` afterwards (owner only): `setFeed(token, aggregator, maxAge)` to list a token,
`removeFeed(token)` to take one off (open orders keep running), `setMinOrderUsd(usd with 18 decimals)` for the
smallest order, `transferOwnership` then `acceptOwnership` to hand the list over.
