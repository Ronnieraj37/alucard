"use client";

import { ChevronRight, Plus, Wallet } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { type Abi } from "viem";
import { useAccount } from "wagmi";
import { Empty, PoolIcons, TxLine } from "@/components/ui";
import { conditionalOrdersAbi } from "@/lib/generated/abis";
import { type PlainPosition, type RulePosition, useMyPositions } from "@/lib/positions";
import { CORE, fmt, maxUsable, minUsable, priceRange } from "@/lib/pools";
import { useTx } from "@/lib/tx";

export default function Positions() {
  const { address: connected } = useAccount();
  // Read-only view of any wallet: /pool?as=0x... (handy for demos)
  const [viewAs, setViewAs] = useState<string | null>(null);
  useEffect(() => setViewAs(new URLSearchParams(window.location.search).get("as")), []);
  const owner = (viewAs as `0x${string}` | null) ?? connected;
  const q = useMyPositions(owner);
  const tx = useTx();

  const withdrawHeld = (currency: `0x${string}`) =>
    tx.run(async () => {
      await tx.send("Withdraw held payout", { address: CORE.conditionalOrders, abi: conditionalOrdersAbi as Abi, functionName: "withdraw", args: [currency, connected] });
      q.refetch();
    });

  const all = [...(q.data?.rules ?? []), ...(q.data?.plain ?? [])];

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-4 py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="page-h">Positions</h1>
          {viewAs && <div className="text-[12px] text-[var(--muted)]">Viewing {viewAs.slice(0, 6)}…{viewAs.slice(-4)} (read-only)</div>}
        </div>
        <Link href="/pool/new" className="btn btn-dark !rounded-full">
          <Plus className="h-4 w-4" /> New position
        </Link>
      </div>
      <TxLine state={tx.state} />

      {q.data?.held.map((h) => (
        <div key={h.currency} className="card flex items-center gap-3 p-3 text-[13px]">
          <Wallet className="h-4 w-4 text-[var(--amber)]" />
          {fmt(h.amount)} {h.symbol} could not be sent to your wallet and is waiting for you.
          <button className="btn btn-dark ml-auto" onClick={() => withdrawHeld(h.currency)}>
            Withdraw
          </button>
        </div>
      ))}

      {!owner && (
        <Empty text="Connect your wallet to see your positions.">
          <a href={`/pool?as=${EXAMPLE_OWNER}`} className="btn btn-light !rounded-full">
            See live example positions
          </a>
        </Empty>
      )}
      {owner && q.isLoading && <Empty text="Loading your positions…" />}
      {q.data && all.length === 0 && (
        <Empty text="You have no positions yet.">
          <Link href="/pool/new" className="btn btn-dark !rounded-full">
            <Plus className="h-4 w-4" /> New position
          </Link>
        </Empty>
      )}

      {[
        ["With a strategy", q.data?.rules ?? []],
        ["Without a strategy", q.data?.plain ?? []],
      ].map(([title, list]) =>
        (list as (RulePosition | PlainPosition)[]).length ? (
          <section key={title as string}>
            <div className="mb-2 text-[12.5px] font-medium text-[var(--muted)]">{title as string}</div>
            <div className="list">
              {(list as (RulePosition | PlainPosition)[]).map((p) => (
                <PositionRow key={`${p.kind}-${p.id}`} p={p} />
              ))}
            </div>
          </section>
        ) : null,
      )}
    </div>
  );
}

/** The deployer's wallet on Sepolia: it holds the live example positions (read-only view for visitors). */
const EXAMPLE_OWNER = "0x02847D22C33f5F060Bd27e69F1a413AD44cab213";

function PositionRow({ p }: { p: RulePosition | PlainPosition }) {
  const full = p.tickLower === minUsable(p.pool.key.tickSpacing) && p.tickUpper === maxUsable(p.pool.key.tickSpacing);
  const [lo, hi] = priceRange(p.pool, p.tickLower, p.tickUpper);
  const inRange = p.tick >= p.tickLower && p.tick < p.tickUpper;
  const ready = p.kind === "rules" && (p.ready.down || p.ready.up);
  // one status, the one that matters most
  const status =
    p.kind === "rules" && ready
      ? { t: "Ready to run", c: "accent" }
      : p.kind === "rules" && p.status === "waiting"
        ? { t: "Moved", c: "blue" }
        : p.kind === "rules" && p.status === "parked"
          ? { t: `In ${p.livePool.base.symbol}/${p.livePool.quote.symbol}`, c: "blue" }
          : inRange
            ? { t: "In range", c: "sage" }
            : { t: "Out of range", c: "amber" };
  const body = (
    <div className="row">
      <PoolIcons pool={p.pool} />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium text-[var(--ink)]">
          {p.pool.base.symbol} / {p.pool.quote.symbol} <span className="font-normal text-[var(--muted)]">{p.pool.key.fee / 10_000}%</span>
        </div>
        <div className="truncate text-[12.5px] text-[var(--muted)]">{full ? "Full range" : `${fmt(lo)} – ${fmt(hi)} ${p.pool.quote.symbol}`}</div>
      </div>
      <span className={`pill ${status.c}`}>{status.t}</span>
      {p.kind === "rules" && <ChevronRight className="h-4 w-4 text-[var(--muted2)]" />}
    </div>
  );
  return p.kind === "rules" ? <Link href={`/pool/${p.id}`}>{body}</Link> : body;
}
