# Testnet deployments

Alucard is deployed on **Ethereum Sepolia** (chain id 11155111) and **Unichain Sepolia** (chain id 1301), with the same
contracts, its own test tokens and pools on each. The JSON files next to this README (`<chain>-core.json`, `-tokens.json`,
`-pools.json`, `-faucet.json`) are written by the deploy scripts and read by the frontend (`frontend/scripts/sync.mjs`).
The app switches between them from the network menu in the header, and follows the wallet's network.

## Ethereum Sepolia

| Contract | Address |
|---|---|
| ConditionalOrders (positions with a strategy) | [`0xa653D69C934B431431C11e55a59bbf69e524Db3c`](https://sepolia.etherscan.io/address/0xa653D69C934B431431C11e55a59bbf69e524Db3c) |
| Rules (pool table, conditions, Chainlink check) | [`0x59AC15D97080BF47be608750d82bB9528e57996E`](https://sepolia.etherscan.io/address/0x59AC15D97080BF47be608750d82bB9528e57996E) |
| RuleHook (hook: limit orders) | [`0x0482555fd63636Baa88bF1eA7d0e48e3F2Cb50C0`](https://sepolia.etherscan.io/address/0x0482555fd63636Baa88bF1eA7d0e48e3F2Cb50C0) |
| PriceFeeds (token list, Chainlink USD feeds, 200-tick band) | [`0xC539EE58250B88F2ECAb86682c06ce4cD6592a1b`](https://sepolia.etherscan.io/address/0xC539EE58250B88F2ECAb86682c06ce4cD6592a1b) |
| USDT mock feed ($1: no Chainlink USDT feed here) | [`0x15C8A66A00421D24e7172bf8Cc8CA4E674b8d6E4`](https://sepolia.etherscan.io/address/0x15C8A66A00421D24e7172bf8Cc8CA4E674b8d6E4) |
| Uniswap v4 PoolManager | [`0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`](https://sepolia.etherscan.io/address/0xE03A1074c86CFeDd5C142C4F04F1a1536e203543) |
| Uniswap v4 PositionManager | [`0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4`](https://sepolia.etherscan.io/address/0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4) |
| Swap router (hookmate) | [`0xf13D190e9117920c703d79B5F33732e10049b115`](https://sepolia.etherscan.io/address/0xf13D190e9117920c703d79B5F33732e10049b115) |
| Test faucet (`drip()`: every test token in one call) | [`0xE991cFD1A6EF2f42CdD2A1633a5605D5ea5d18fF`](https://sepolia.etherscan.io/address/0xE991cFD1A6EF2f42CdD2A1633a5605D5ea5d18fF) |

Deployed from block 12218473. Test tokens (open mint, no value):

| Token | Decimals | Address |
|---|---|---|
| tWETH | 18 | [`0x4119A4dab16764aD6056DD6C7f744F6cd8d9B4Ca`](https://sepolia.etherscan.io/address/0x4119A4dab16764aD6056DD6C7f744F6cd8d9B4Ca) |
| tWBTC | 8 | [`0x3630EEB9719BCabC532f049Ef663991f4E110E74`](https://sepolia.etherscan.io/address/0x3630EEB9719BCabC532f049Ef663991f4E110E74) |
| tUSDC | 6 | [`0x5B7E3901456fEd7158D583FBaA9736fff611Fc5b`](https://sepolia.etherscan.io/address/0x5B7E3901456fEd7158D583FBaA9736fff611Fc5b) |
| tUSDT | 6 | [`0x9289d26a4B38d3CBCc25471f1e69cbbc8d4a8121`](https://sepolia.etherscan.io/address/0x9289d26a4B38d3CBCc25471f1e69cbbc8d4a8121) |
| tDAI | 18 | [`0x58e283AFE1Db9704EB73cFBB0032b8DEBeC9b719`](https://sepolia.etherscan.io/address/0x58e283AFE1Db9704EB73cFBB0032b8DEBeC9b719) |
| tLINK | 18 | [`0xCe340f6faE8c61787f4Af123a97e344b53122510`](https://sepolia.etherscan.io/address/0xCe340f6faE8c61787f4Af123a97e344b53122510) |

| Index | Pool | Fee | Hook |
|---|---|---|---|
| 1 | WETH / USDC | 0.3% | RuleHook |
| 2 | WBTC / USDC | 0.3% | RuleHook |
| 3 | WETH / WBTC | 0.05% | RuleHook |
| 4 | USDC / USDT | 0.01% | RuleHook |
| 5 | LINK / WETH | 1% | RuleHook |
| 6 | DAI / USDC | 0.01% | RuleHook |
| 7 | WETH / USDC | 0.05% | none |
| 8 | ETH / USDC | 0.3% | RuleHook |

## Unichain Sepolia

| Contract | Address |
|---|---|
| ConditionalOrders (positions with a strategy) | [`0xb190f93B9511B40c12F068b9bdd2d392aBAC3FBD`](https://sepolia.uniscan.xyz/address/0xb190f93B9511B40c12F068b9bdd2d392aBAC3FBD) |
| Rules (pool table, conditions, Chainlink check) | [`0x67CB05bb62b72DCbd359670acEb53E0159bda947`](https://sepolia.uniscan.xyz/address/0x67CB05bb62b72DCbd359670acEb53E0159bda947) |
| RuleHook (hook: limit orders) | [`0x8B7f7798eE5d9Af14529eB964A1e912b670890C0`](https://sepolia.uniscan.xyz/address/0x8B7f7798eE5d9Af14529eB964A1e912b670890C0) |
| PriceFeeds (token list, Chainlink USD feeds, 200-tick band) | [`0xA7dD5FCE507A4b6F0a24aBdCB169DaA023746C36`](https://sepolia.uniscan.xyz/address/0xA7dD5FCE507A4b6F0a24aBdCB169DaA023746C36) |
| DAI mock feed ($1: no Chainlink DAI feed here) | [`0x95f9ACE4b9480B3712DF0A56013568693dDFe36E`](https://sepolia.uniscan.xyz/address/0x95f9ACE4b9480B3712DF0A56013568693dDFe36E) |
| Uniswap v4 PoolManager | [`0x00B036B58a818B1BC34d502D3fE730Db729e62AC`](https://sepolia.uniscan.xyz/address/0x00B036B58a818B1BC34d502D3fE730Db729e62AC) |
| Uniswap v4 PositionManager | [`0xf969Aee60879C54bAAed9F3eD26147Db216Fd664`](https://sepolia.uniscan.xyz/address/0xf969Aee60879C54bAAed9F3eD26147Db216Fd664) |
| Swap router (hookmate) | [`0x9cD2b0a732dd5e023a5539921e0FD1c30E198Dba`](https://sepolia.uniscan.xyz/address/0x9cD2b0a732dd5e023a5539921e0FD1c30E198Dba) |
| Test faucet (`drip()`: every test token in one call) | [`0x5BDF7BbA1EEb414A47761772c92F2c0F66F70746`](https://sepolia.uniscan.xyz/address/0x5BDF7BbA1EEb414A47761772c92F2c0F66F70746) |

Deployed from block 68868194. Test tokens (open mint, no value):

| Token | Decimals | Address |
|---|---|---|
| tWETH | 18 | [`0x196d4119944CD005AD917466B8e2e2Ec018FA547`](https://sepolia.uniscan.xyz/address/0x196d4119944CD005AD917466B8e2e2Ec018FA547) |
| tWBTC | 8 | [`0xb62D0cDd1ac95b4C443674c5DE4CcB60838CF0C6`](https://sepolia.uniscan.xyz/address/0xb62D0cDd1ac95b4C443674c5DE4CcB60838CF0C6) |
| tUSDC | 6 | [`0xE6548fDD1a8eEe78012d0E3e8A1e0ACb7788AC40`](https://sepolia.uniscan.xyz/address/0xE6548fDD1a8eEe78012d0E3e8A1e0ACb7788AC40) |
| tUSDT | 6 | [`0xae24032c24438f3fd689C9b76d704fe036C88F5f`](https://sepolia.uniscan.xyz/address/0xae24032c24438f3fd689C9b76d704fe036C88F5f) |
| tDAI | 18 | [`0x018b59D2b831955371320812693D54e51E563223`](https://sepolia.uniscan.xyz/address/0x018b59D2b831955371320812693D54e51E563223) |
| tLINK | 18 | [`0xA10746e38636d122eE47F9fC5330ca7b0DbE78D2`](https://sepolia.uniscan.xyz/address/0xA10746e38636d122eE47F9fC5330ca7b0DbE78D2) |

| Index | Pool | Fee | Hook |
|---|---|---|---|
| 1 | WETH / USDC | 0.3% | RuleHook |
| 2 | WBTC / USDC | 0.3% | RuleHook |
| 3 | WETH / WBTC | 0.05% | RuleHook |
| 4 | USDC / USDT | 0.01% | RuleHook |
| 5 | LINK / WETH | 1% | RuleHook |
| 6 | DAI / USDC | 0.01% | RuleHook |
| 7 | WETH / USDC | 0.05% | none |
| 8 | ETH / USDC | 0.3% | RuleHook |

Pools start at the chain's Chainlink prices with the deployer's liquidity; `frontend/scripts/arb.ts` keeps them on
Chainlink (`CHAIN=unichain` for Unichain). A strategy step runs only while its pool is within 200 ticks (~2%) of Chainlink.

Chainlink feeds on Unichain Sepolia (24 h heartbeat): ETH / USD `0xd9c93081210dFc33326B2af4C2c11848095E6a9a`, BTC / USD
`0x2AF69319fACBbc1ad77d56538B35c1f9FFe86dEF`, LINK / USD `0x331b7521a8985dbDdA5CF4FCDB57EC25465C55cB`, USDC / USD
`0x25DdD2fEd0d51fe79d292Da47dd9f10AbdB4b3EC`, USDT / USD `0xd391fB4c7D0B88dc44530E785246112388AFA98F` (`script/sepolia/Net.sol`).

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

