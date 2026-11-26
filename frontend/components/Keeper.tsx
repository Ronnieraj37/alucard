"use client";

import { useQuery } from "@tanstack/react-query";
import { Bot, Play, RefreshCw } from "lucide-react";
import { type Abi } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { Empty, TxLine } from "@/components/ui";
import { conditionalOrdersAbi } from "@/lib/generated/abis";
import { CORE } from "@/lib/pools";
import { liveLanes, liveSide, loadRulePosition } from "@/lib/positions";
import { type LaneId, describeLane, describeWhen } from "@/lib/rules";
import { useTx } from "@/lib/tx";

/** Anyone can run a strategy step once its condition is true, and is paid its owner's keeper fee. */
export default function Keeper() {
  const client = usePublicClient();
  const { address } = useAccount();
  const tx = useTx();
  const q = useQuery({
    queryKey: ["keeper"],
    enabled: !!client,
    refetchInterval: 15_000,
    queryFn: async () => {
      const next = await client!.readContract({ address: CORE.conditionalOrders, abi: conditionalOrdersAbi, functionName: "nextOrderId" });
      const ready: { id: bigint; upper: boolean; text: string; label: string }[] = [];
      const pokes: { id: bigint; upper: boolean; text: string; label: string }[] = [];
      let open = 0;
      for (let id = 1n; id < next; id++) {
        const p = await loadRulePosition(client!, id);
        if (!p) continue;
        open++;
        const lanes = liveLanes(p);
        for (const lane of ["down", "up"] as LaneId[]) {
          const L = lanes[lane];
          const text = p.liveIsHome ? describeLane(p.pool, lane, L, p.rules.plan) ?? "" : L.trigger ? `${describeWhen(p.pool, lane, L)}: come back` : "";
          const item = { id, upper: liveSide(p, lane), text, label: p.pool.label };
          if (p.ready[lane]) ready.push(item);
          else if (p.memo[lane]?.pokeable) pokes.push(item);
        }
      }
      return { open, ready, pokes };
    },
  });

  // Each ready step is its own transaction: each pays you its owner's keeper fee.
  const runAll = () =>
    tx.run(async () => {
      for (const r of q.data?.ready ?? []) {
        await tx.send(`Run #${r.id}`, { address: CORE.conditionalOrders, abi: conditionalOrdersAbi as Abi, functionName: "execute", args: [r.id, r.upper] });
      }
      q.refetch();
    }, "All ready steps ran. The keeper fees arrived in your wallet.");

  // Pokes move trailing stops' best price and start holds. They are not paid; they keep other people's strategies up to date.
  const pokeAll = () =>
    tx.run(async () => {
      for (const r of q.data?.pokes ?? []) {
        await tx.send(`Update #${r.id}`, { address: CORE.conditionalOrders, abi: conditionalOrdersAbi as Abi, functionName: "poke", args: [r.id, r.upper] });
      }
      q.refetch();
    }, "Updated.");

  return (
    <div className="mx-auto flex max-w-[680px] flex-col gap-4 px-4 py-8">
      <div className="flex items-start gap-3">
        <div>
          <h1 className="text-xl font-semibold">Keeper</h1>
          <div className="text-[13px] text-[var(--muted)]">
            A strategy step runs when someone sends the transaction. Keepers do it automatically; anyone can, and is paid the owner's keeper fee from that position.
          </div>
        </div>
        <button className="btn btn-light ml-auto !p-2" onClick={() => q.refetch()} title="Refresh">
          <RefreshCw className={`h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} />
        </button>
      </div>
      <div className="text-[13px] text-[var(--muted)]">{q.data ? `${q.data.open} open positions with a strategy, ${q.data.ready.length} ready to run.` : "Checking…"}</div>
      {q.data && q.data.ready.length === 0 && <Empty text="Nothing to run right now. Move a price on the Swap page to trigger a strategy." />}
      <div className="flex flex-col gap-2">
        {q.data?.ready.map((r) => (
          <div key={`${r.id}-${r.upper}`} className="card flex items-start gap-3 p-3 text-[13px]">
            <Bot className="mt-0.5 h-4 w-4 text-[var(--muted)]" />
            <div>
              <div className="font-semibold">
                #{String(r.id)} · {r.label}
              </div>
              <div className="text-[var(--muted)]">{r.text}</div>
            </div>
          </div>
        ))}
      </div>
      {!!q.data?.ready.length && (
        <button className="btn btn-dark !rounded-[14px] !py-3" disabled={!address || tx.state.busy} onClick={runAll}>
          <Play className="h-4 w-4" /> {address ? "Run all ready steps" : "Connect a wallet to run them"}
        </button>
      )}
      {!!q.data?.pokes.length && (
        <div className="card flex flex-col gap-2 p-3 text-[13px]">
          <div className="font-semibold">To update ({q.data.pokes.length})</div>
          <div className="text-[var(--muted)]">
            Trailing stops remember the best price, and “only if it lasts” needs to be seen true first: someone has to update them as the price moves. Updating moves no tokens and is not paid.
          </div>
          {q.data.pokes.map((r) => (
            <div key={`p-${r.id}-${r.upper}`} className="text-[var(--muted)]">
              #{String(r.id)} · {r.label}: {r.text}
            </div>
          ))}
          <button className="btn btn-light" disabled={!address || tx.state.busy} onClick={pokeAll}>
            <RefreshCw className="h-4 w-4" /> Update them
          </button>
        </div>
      )}
      <TxLine state={tx.state} />
    </div>
  );
}
