# Sepolia deployment

Everything here is on **Ethereum Sepolia** (chain id 11155111). The JSON files next to this README are written by the deploy scripts and read by the frontend (`frontend/scripts/sync.mjs`).

## Contracts

| Contract | Address |
|---|---|
| ConditionalOrders (positions with a strategy) | [`0x6CD66E4c91635E2C7705fa2CE61Ac6df24cb12d3`](https://sepolia.etherscan.io/address/0x6CD66E4c91635E2C7705fa2CE61Ac6df24cb12d3) |
| Rules (pool table, conditions, Chainlink check) | [`0xc2c6CC90005823829c2Cf0415D9cD30dae8705D3`](https://sepolia.etherscan.io/address/0xc2c6CC90005823829c2Cf0415D9cD30dae8705D3) |
| RuleHook (hook: limit orders) | [`0x5F8Bfff761fE01aE2586a19036dfdC0C1220D0C0`](https://sepolia.etherscan.io/address/0x5F8Bfff761fE01aE2586a19036dfdC0C1220D0C0) |
| PriceFeeds (token list, Chainlink USD feeds, 200-tick band) | [`0x6Ea9DCEF1EA55001E2a87FafA0F6b7D0cCe45DF6`](https://sepolia.etherscan.io/address/0x6Ea9DCEF1EA55001E2a87FafA0F6b7D0cCe45DF6) |
| USDT mock feed ($1, no Chainlink feed on Sepolia) | [`0x15C8A66A00421D24e7172bf8Cc8CA4E674b8d6E4`](https://sepolia.etherscan.io/address/0x15C8A66A00421D24e7172bf8Cc8CA4E674b8d6E4) |
| Uniswap v4 PoolManager | [`0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`](https://sepolia.etherscan.io/address/0xE03A1074c86CFeDd5C142C4F04F1a1536e203543) |
| Uniswap v4 PositionManager | [`0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4`](https://sepolia.etherscan.io/address/0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4) |
| Swap router (hookmate) | [`0xf13D190e9117920c703d79B5F33732e10049b115`](https://sepolia.etherscan.io/address/0xf13D190e9117920c703d79B5F33732e10049b115) |

Deployed 2026-11-26 (`02_DeployCore`, `03_CreatePools`). Earlier deployments stay on Sepolia and are retired: see
`DEPLOY.md`.

## Test tokens

Open mint: anyone can call `mint(to, amount)`. No value. Reuse them; do not redeploy.

Faucet (all six tokens in one transaction: 100 tWETH, 5 tWBTC, 500k tUSDC/tUSDT/tDAI, 20k tLINK): `drip()` on
[`0xE991cFD1A6EF2f42CdD2A1633a5605D5ea5d18fF`](https://sepolia.etherscan.io/address/0xE991cFD1A6EF2f42CdD2A1633a5605D5ea5d18fF).

| Token | Decimals | Address |
|---|---|---|
| tWETH | 18 | [`0x4119A4dab16764aD6056DD6C7f744F6cd8d9B4Ca`](https://sepolia.etherscan.io/address/0x4119A4dab16764aD6056DD6C7f744F6cd8d9B4Ca) |
| tWBTC | 8 | [`0x3630EEB9719BCabC532f049Ef663991f4E110E74`](https://sepolia.etherscan.io/address/0x3630EEB9719BCabC532f049Ef663991f4E110E74) |
| tUSDC | 6 | [`0x5B7E3901456fEd7158D583FBaA9736fff611Fc5b`](https://sepolia.etherscan.io/address/0x5B7E3901456fEd7158D583FBaA9736fff611Fc5b) |
| tUSDT | 6 | [`0x9289d26a4B38d3CBCc25471f1e69cbbc8d4a8121`](https://sepolia.etherscan.io/address/0x9289d26a4B38d3CBCc25471f1e69cbbc8d4a8121) |
| tDAI | 18 | [`0x58e283AFE1Db9704EB73cFBB0032b8DEBeC9b719`](https://sepolia.etherscan.io/address/0x58e283AFE1Db9704EB73cFBB0032b8DEBeC9b719) |
| tLINK | 18 | [`0xCe340f6faE8c61787f4Af123a97e344b53122510`](https://sepolia.etherscan.io/address/0xCe340f6faE8c61787f4Af123a97e344b53122510) |

## Pools

Started at the Sepolia Chainlink prices at deploy time (USDT has no feed there and starts at $1). Liquidity added by the
deployer as a normal LP. Every pool is in Rules' table, so strategies can use all of them (the hookless one too); limit
orders need the hook. `frontend/scripts/arb.ts` keeps them on Chainlink: a strategy step runs only while its pool is
within 200 ticks (~2%) of Chainlink.

| Index | Pool | Fee | Spacing | Hook | Liquidity |
|---|---|---|---|---|---|
| 1 | WETH / USDC | 0.3% | 60 | RuleHook | full range $5M/side + ±5% $2M/side |
| 2 | WBTC / USDC | 0.3% | 60 | RuleHook | full range $5M/side + ±10% $2M/side |
| 3 | WBTC / WETH | 0.05% | 10 | RuleHook | ±2% $2M/side |
| 4 | USDC / USDT | 0.01% | 1 | RuleHook | ±0.2% $5M/side |
| 5 | WETH / LINK | 1.0% | 200 | RuleHook | full range $2M/side |
| 6 | DAI / USDC | 0.01% | 1 | RuleHook | ±0.5% $3M/side |
| 7 | WETH / USDC | 0.05% | 10 | none | full range $5M/side (an older pool, reused) |
| 8 | ETH / USDC | 0.3% | 60 | RuleHook | full range + ±5%, ~$10/side each (real Sepolia ETH) |

## Re-running

The deployer key is read from `.env` (`PRIVATE_KEY`, never committed). Sepolia now charges far more gas for creating
contracts and storage than Foundry's local simulation assumes, so every command adds `--gas-estimate-multiplier 1000`
(gas is ~17 wei there, so this costs nothing). Without it, deployments run out of gas. Sepolia also caps one
transaction at about 16.7M gas, so for calls with a large estimate (the trial's `keep` phase) use
`--gas-estimate-multiplier 300` instead, or the transaction is refused before it is sent.

```bash
forge script script/sepolia/01_DeployTokens.s.sol --rpc-url $SEPOLIA_RPC --private-key $PRIVATE_KEY --broadcast --slow --gas-estimate-multiplier 1000
forge script script/sepolia/02_DeployCore.s.sol   --rpc-url $SEPOLIA_RPC --private-key $PRIVATE_KEY --broadcast --slow --gas-estimate-multiplier 1000
forge script script/sepolia/03_CreatePools.s.sol  --rpc-url $SEPOLIA_RPC --private-key $PRIVATE_KEY --broadcast --slow --gas-estimate-multiplier 1000
```

Trial orders: `script/sepolia/04_Trial.s.sol` with `PHASE=orders`. Its `up` / `down` phases push the pools with swaps:
since steps only run near Chainlink, that now shows that a push alone runs nothing (the arbitrage bot then takes the push
back). Real runs come from real market moves.

After a new deployment: `cd frontend && npm run sync`.

## Live examples (2026-11-26)

`04_Trial PHASE=orders` (orders #1-#6: take profit, stop loss with swap, re-centre on leaving, compound every minute, a
WBTC exit watching the hookless WETH/USDC pool, native ETH take profit; limit orders 1 and 2) and
`frontend/scripts/demo-orders.ts` (#7 moves into USDT/USDC below the range and comes back 0.5% inside it, #8 holds USDC
above the range and comes back centred on a 1% turn, #9 a stop loss confirmed for 15 minutes). Their ranges are tight, so
real ETH moves trigger them while `npx tsx scripts/arb.ts --keep` runs.

