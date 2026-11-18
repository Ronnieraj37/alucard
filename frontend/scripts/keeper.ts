// Keeper bot: finds every rule whose condition is met and executes it.
// Sides that do not swap go together in one executeMany transaction (each owner pays less gas that way). A side that
// converts moves the pool's price, and the contract refuses later orders of that pool in the same transaction, so
// those go one transaction each.
// It is paid back its gas from the positions it runs, in ETH or in the pool's tokens (see ConditionalOrders._settle).
// It also pokes sides that remember something between runs: it arms holds whose condition has become true and moves
// trailing stops to a new best price. Pokes are not paid, but they cost very little and keep the rules working.
//
//   KEEPER_PRIVATE_KEY=0x... RPC_URL=https://... npx tsx scripts/keeper.ts
//   DRY_RUN=1 ...   lists what it would run, sends nothing
//
// Runs once and exits, so a scheduler (GitHub Actions cron) can call it every few minutes.
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { conditionalOrdersAbi } from "../lib/generated/abis";
import deployment from "../lib/generated/deployment.json";

const ORDERS = deployment.core.conditionalOrders as `0x${string}`;
const RPC = process.env.RPC_URL ?? process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const KEY = process.env.KEEPER_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
const DRY = !!process.env.DRY_RUN;

async function main() {
  const client = createPublicClient({ chain: sepolia, transport: http(RPC) });
  const c = { address: ORDERS, abi: conditionalOrdersAbi } as const;

  const next = await client.readContract({ ...c, functionName: "nextOrderId" });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const ready: { id: bigint; upper: boolean; swaps: boolean }[] = [];
  const pokes: { id: bigint; upper: boolean }[] = [];
  for (let id = 1n; id < next; id++) {
    const [order, st] = await client.readContract({ ...c, functionName: "getOrder", args: [id] });
    if (order.owner === "0x0000000000000000000000000000000000000000" || BigInt(order.expiry) < now) continue;
    const [lower, upper] = await Promise.all([
      client.readContract({ ...c, functionName: "canExecute", args: [id, false] }),
      client.readContract({ ...c, functionName: "canExecute", args: [id, true] }),
    ]);
    const ACT_SWAP = 4;
    if (lower) ready.push({ id, upper: false, swaps: (st.lower.actions & ACT_SWAP) !== 0 });
    if (upper) ready.push({ id, upper: true, swaps: (st.upper.actions & ACT_SWAP) !== 0 });
    // A side with a hold or a trailing stop may need a poke. Only a poke that would change something succeeds.
    for (const [isUpper, sd, isReady] of [[false, st.lower, lower], [true, st.upper, upper]] as const) {
      const trails = sd.checker === 4 || (sd.combine !== 0 && sd.checker2 === 4);
      if (isReady || (!sd.holdMinutes && !trails)) continue;
      const ok = await client
        .simulateContract({ ...c, functionName: "poke", args: [id, isUpper] })
        .then(() => true)
        .catch(() => false);
      if (ok) pokes.push({ id, upper: isUpper });
    }
  }
  console.log(`${Number(next) - 1} orders checked, ${ready.length} ready, ${pokes.length} to poke`);
  if ((!ready.length && !pokes.length) || DRY) return;
  if (!KEY) {
    console.log("No KEEPER_PRIVATE_KEY set: nothing sent.");
    return;
  }

  const account = privateKeyToAccount((KEY.startsWith("0x") ? KEY : `0x${KEY}`) as Hex);
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });
  for (const r of pokes) {
    const label = `poke #${r.id} ${r.upper ? "upper" : "lower"}`;
    try {
      const { request } = await client.simulateContract({ ...c, account, functionName: "poke", args: [r.id, r.upper] });
      const hash = await wallet.writeContract(request);
      const receipt = await client.waitForTransactionReceipt({ hash });
      console.log(`${label}: ${receipt.status} ${hash}`);
    } catch (e) {
      console.log(`${label}: skipped (${(e as Error).message.split("\n")[0]})`);
    }
  }
  // everything that does not swap, 40 sides per transaction
  const plain = ready.filter((r) => !r.swaps);
  const single = ready.filter((r) => r.swaps);
  if (plain.length === 1) single.push(plain.pop()!);
  for (let i = 0; i < plain.length; i += 40) {
    const batch = plain.slice(i, i + 40);
    const args = [batch.map((r) => r.id), batch.map((r) => r.upper)] as const;
    const label = `batch of ${batch.length} (${batch.map((r) => `#${r.id}${r.upper ? "u" : "l"}`).join(" ")})`;
    try {
      const { request, result } = await client.simulateContract({ ...c, account, functionName: "executeMany", args });
      if (result === 0n) {
        console.log(`${label}: nothing would run`);
        continue;
      }
      // the contract reverts a batch that is given too little gas, so this estimate covers every order in it
      const gas = await client.estimateContractGas({ ...c, account, functionName: "executeMany", args });
      const hash = await wallet.writeContract({ ...request, gas: (gas * 15n) / 10n });
      const receipt = await client.waitForTransactionReceipt({ hash });
      console.log(`${label}: ${receipt.status}, ${result} would run, ${hash}`);
    } catch (e) {
      console.log(`${label}: skipped (${(e as Error).message.split("\n")[0]})`);
    }
  }
  for (const r of single) {
    const label = `#${r.id} ${r.upper ? "upper" : "lower"}`;
    try {
      // Re-check on the latest block: another keeper may have run it, or the price moved back.
      const { request } = await client.simulateContract({ ...c, account, functionName: "execute", args: [r.id, r.upper] });
      const gas = await client.estimateContractGas({ ...c, account, functionName: "execute", args: [r.id, r.upper] });
      const hash = await wallet.writeContract({ ...request, gas: (gas * 12n) / 10n });
      const receipt = await client.waitForTransactionReceipt({ hash });
      console.log(`${label}: ${receipt.status} ${hash}`);
    } catch (e) {
      console.log(`${label}: skipped (${(e as Error).message.split("\n")[0]})`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
