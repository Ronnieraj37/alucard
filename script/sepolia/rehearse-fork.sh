#!/usr/bin/env bash
# Rehearse the whole Sepolia deployment on a local fork, then test it end to end. Nothing is sent to Sepolia.
#
#   anvil --fork-url "$SEPOLIA_RPC" --port 8546          (in another terminal)
#   script/sepolia/rehearse-fork.sh
#
# Deploys the core and the pools into deployments/fork/ (the real deployments/ files are not touched), points the
# frontend at the fork (lib/generated, api/_data), lets an hour pass so pools have average prices, then runs
# check-rules (every template against the contract) and e2e-fork (real swaps, the keeper, plan B).
# Afterwards `cd frontend && npm run sync` points the frontend back at the real deployment.
set -euo pipefail
cd "$(dirname "$0")/../.."
RPC=http://127.0.0.1:8546
set -a; source .env; set +a
cast block-number --rpc-url "$RPC" >/dev/null || { echo "no fork on $RPC: start anvil first"; exit 1; }

mkdir -p deployments/fork
OUT_DIR=./deployments/fork forge script script/sepolia/02_DeployCore.s.sol --rpc-url "$RPC" --broadcast --private-key "$PRIVATE_KEY" | grep -E "RuleHook|Rules|ConditionalOrders|PriceFeeds"
OUT_DIR=./deployments/fork forge script script/sepolia/03_CreatePools.s.sol --rpc-url "$RPC" --broadcast --private-key "$PRIVATE_KEY" | grep -E "_[0-9]+ |NOHOOK"
(cd frontend && SYNC_DIR=deployments/fork npm run sync --silent)

cast rpc evm_increaseTime 3600 --rpc-url "$RPC" >/dev/null
cast rpc evm_mine --rpc-url "$RPC" >/dev/null

cd frontend
RPC_URL=$RPC npx tsx scripts/check-rules.ts 2>&1 | grep -vi deprecation | tail -3
RPC_URL=$RPC npx tsx scripts/e2e-fork.ts 2>&1 | grep -vi deprecation
