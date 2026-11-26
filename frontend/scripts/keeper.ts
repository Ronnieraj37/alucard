// Keeper bot: runs every strategy step whose condition is true, one transaction each, and is paid each order's keeper
// fee (a set share of what the step moves, chosen by its owner). It also pokes: a trailing side's best price, and a side
// with a hold ("only if it lasts"), which needs to be seen true first. Pokes are not paid; they cost very little.
//
//   KEEPER_PRIVATE_KEY=0x... RPC_URL=https://... npx tsx scripts/keeper.ts
//   DRY_RUN=1 ...   lists what it would run, sends nothing
//
// Runs once and exits, so a scheduler (GitHub Actions cron, or scripts/arb.ts --keep) can call it every few minutes.
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
    // A trailing side, or a side with a hold, may need a poke. Only a poke that would change something succeeds.
    for (const [isUpper, word, isReady] of [
      [false, order.lowerState, lower],
      [true, order.upperState, upper],
    ] as const) {
      const sd = decodeSide(word);
      const trails = sd.checker === CHECK.TRAIL || (sd.combine !== 0 && sd.checker2 === CHECK.TRAIL);
      if (isReady || (!trails && !sd.holdMinutes)) continue;
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
  const send = async (label: string, functionName: "poke" | "execute", id: bigint, upper: boolean) => {
    try {
      // re-checked on the latest block: another keeper may have run it, or the price moved back
      const { request } = await client.simulateContract({ ...c, account, functionName, args: [id, upper] });
      const gas = await client.estimateContractGas({ ...c, account, functionName, args: [id, upper] });
      const hash = await wallet.writeContract({ ...request, gas: withHeadroom(gas) });
      const receipt = await client.waitForTransactionReceipt({ hash });
      log(`${label}: ${receipt.status} ${hash}`);
      return receipt;
    } catch (e) {
      log(`${label}: skipped (${(e as Error).message.split("\n")[0]})`);
      return null;
    }
  };
  let sent = 0;
  for (const p of pokes) await send(`poke #${p.id} ${p.upper ? "upper" : "lower"}`, "poke", p.id, p.upper);
  for (const x of ready) {
    const receipt = await send(`run #${x.id} ${x.upper ? "upper" : "lower"}`, "execute", x.id, x.upper);
    if (!receipt) continue;
    const events = parseEventLogs({ abi: conditionalOrdersAbi, logs: receipt.logs, eventName: ["OrderExecuted", "OrderMoved", "OrderClosed"] });
    if (events.some((e) => e.address.toLowerCase() === ORDERS.toLowerCase())) sent++;
  }
  return { ready, pokes, sent };
}

if (process.argv[1]?.endsWith("keeper.ts")) {
  keep().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
