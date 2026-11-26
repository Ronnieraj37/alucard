// Keeper bot: finds every rule whose condition is met and runs them, all in executeMany transactions (each owner pays
// less gas that way; an order that cannot run any more is skipped by the contract, the rest still run).
// It is paid back its gas from the positions it runs, in ETH or in the pool's tokens (see Rules.keeperPay).
// It also pokes trailing stops: it moves their remembered best price to the current average. Pokes are not paid, but
// they cost very little and keep the rules working.
//
//   KEEPER_PRIVATE_KEY=0x... RPC_URL=https://... npx tsx scripts/keeper.ts
//   DRY_RUN=1 ...   lists what it would run, sends nothing
//
// Runs once and exits, so a scheduler (GitHub Actions cron) can call it every few minutes.
import { createPublicClient, createWalletClient, http, parseEventLogs, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { withHeadroom } from "../lib/gas";
import { sepolia } from "viem/chains";
import { conditionalOrdersAbi, rulesAbi } from "../lib/generated/abis";
import deployment from "../lib/generated/deployment.json";
import { CHECK, decodeSide } from "../lib/side";

const ORDERS = deployment.core.conditionalOrders as `0x${string}`;
const RULES = (deployment.core as { rules: string }).rules as `0x${string}`;
const RPC = process.env.RPC_URL ?? process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const KEY = process.env.KEEPER_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
const DRY = !!process.env.DRY_RUN;
const BATCH = 30;

export async function keep(rpc = RPC, key = KEY, dry = DRY, log = console.log) {
  const client = createPublicClient({ chain: sepolia, transport: http(rpc) });
  const c = { address: ORDERS, abi: conditionalOrdersAbi } as const;
  const r = { address: RULES, abi: rulesAbi } as const;

  const next = await client.readContract({ ...c, functionName: "nextOrderId" });
  const ready: { id: bigint; upper: boolean }[] = [];
  const pokes: { id: bigint; upper: boolean }[] = [];
  for (let id = 1n; id < next; id++) {
    const order = await client.readContract({ ...c, functionName: "getOrder", args: [id] });
    if (order.owner === "0x0000000000000000000000000000000000000000") continue;
    const [lower, upper] = await Promise.all([
      client.readContract({ ...r, functionName: "canExecute", args: [ORDERS, id, false] }),
      client.readContract({ ...r, functionName: "canExecute", args: [ORDERS, id, true] }),
    ]);
    if (lower) ready.push({ id, upper: false });
    if (upper) ready.push({ id, upper: true });
    // A trailing side may need a poke. Only a poke that would change something succeeds.
    for (const [isUpper, word, isReady] of [
      [false, order.lowerState, lower],
      [true, order.upperState, upper],
    ] as const) {
      const sd = decodeSide(word);
      const trails = sd.checker === CHECK.TRAIL || (sd.combine !== 0 && sd.checker2 === CHECK.TRAIL);
      if (isReady || !trails) continue;
      const ok = await client
        .simulateContract({ ...c, functionName: "poke", args: [id, isUpper] })
        .then(() => true)
        .catch(() => false);
      if (ok) pokes.push({ id, upper: isUpper });
    }
  }
  log(`${Number(next) - 1} orders checked, ${ready.length} ready, ${pokes.length} to poke`);
  if ((!ready.length && !pokes.length) || dry) return { ready, pokes, sent: 0 };
  if (!key) {
    log("No KEEPER_PRIVATE_KEY set: nothing sent.");
    return { ready, pokes, sent: 0 };
  }

  const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpc) });
  let sent = 0;
  for (const p of pokes) {
    const label = `poke #${p.id} ${p.upper ? "upper" : "lower"}`;
    try {
      const { request } = await client.simulateContract({ ...c, account, functionName: "poke", args: [p.id, p.upper] });
      const hash = await wallet.writeContract(request);
      const receipt = await client.waitForTransactionReceipt({ hash });
      log(`${label}: ${receipt.status} ${hash}`);
    } catch (e) {
      log(`${label}: skipped (${(e as Error).message.split("\n")[0]})`);
    }
  }
  for (let i = 0; i < ready.length; i += BATCH) {
    const batch = ready.slice(i, i + BATCH);
    const args = [batch.map((x) => x.id), batch.map((x) => x.upper)] as const;
    const label = `batch of ${batch.length} (${batch.map((x) => `#${x.id}${x.upper ? "u" : "l"}`).join(" ")})`;
    try {
      // re-checked on the latest block: another keeper may have run some, or the price moved back
      const { request, result } = await client.simulateContract({ ...c, account, functionName: "executeMany", args });
      if (result === 0n) {
        log(`${label}: nothing would run`);
        continue;
      }
      // the contract reverts a batch that is given too little gas, so this estimate covers every order in it
      const gas = await client.estimateContractGas({ ...c, account, functionName: "executeMany", args });
      const hash = await wallet.writeContract({ ...request, gas: withHeadroom(gas) });
      const receipt = await client.waitForTransactionReceipt({ hash });
      // what really ran (the simulation ran a block earlier): one event per order that ran
      const events = parseEventLogs({ abi: conditionalOrdersAbi, logs: receipt.logs, eventName: ["OrderExecuted", "OrderMoved", "OrderClosed"] });
      const ran = new Set(events.filter((e) => e.address.toLowerCase() === ORDERS.toLowerCase()).map((e) => String((e.args as { orderId: bigint }).orderId))).size;
      sent += ran;
      log(`${label}: ${receipt.status}, ${ran} ran, ${hash}`);
    } catch (e) {
      log(`${label}: skipped (${(e as Error).message.split("\n")[0]})`);
    }
  }
  return { ready, pokes, sent };
}

if (process.argv[1]?.endsWith("keeper.ts")) {
  keep().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
