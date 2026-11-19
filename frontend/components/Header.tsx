"use client";

import { Droplets, Wallet } from "lucide-react";
import { APP_NAME } from "@/lib/brand";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type Abi } from "viem";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { sepolia } from "wagmi/chains";
import { faucetAbi } from "@/lib/generated/abis";
import { CORE } from "@/lib/pools";
import { useTx } from "@/lib/tx";

const NAV = [
  { href: "/swap", label: "Swap" },
  { href: "/pool", label: "Pool" },
  { href: "/keeper", label: "Keeper" },
  { href: "/docs", label: "Docs" },
];

export default function Header() {
  const path = usePathname();
  const { address, chainId, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const tx = useTx();
  const wrongChain = isConnected && chainId !== sepolia.id;

  // the landing page has its own navigation
  if (path === "/") return null;

  // One transaction: the faucet contract mints every test token to the caller.
  const faucet = () =>
    tx.run(async () => {
      await tx.send("Get test tokens", { address: CORE.faucet, abi: faucetAbi as Abi, functionName: "drip", args: [] });
    }, "Added 100 tWETH, 5 tWBTC, 500k tUSDC/tUSDT/tDAI, 20k tLINK");

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-[var(--paper)]/90 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-[1200px] items-center gap-3 px-4 sm:gap-6">
        <Link href="/" className="flex items-center gap-2.5">
          <svg viewBox="0 0 64 64" className="h-7 w-7" aria-hidden="true">
            <circle cx="32" cy="32" r="30" fill="#fbfbfc" stroke="#1b1d22" strokeWidth="3" />
            <circle cx="32" cy="32" r="17" fill="#d7c39a" stroke="#9a7a45" strokeWidth="2" />
            <circle cx="32" cy="32" r="11" fill="#a3122a" />
            <circle cx="28.5" cy="28.5" r="3.5" fill="#ff9aa9" opacity="0.8" />
          </svg>
          <span className="display hidden text-[20px] tracking-[-0.02em] sm:inline">{APP_NAME}</span>
        </Link>
        <nav className="flex gap-1">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`relative px-2 py-1.5 text-[15px] sm:px-3 ${path.startsWith(n.href) ? "text-[var(--ink)] after:absolute after:inset-x-3 after:-bottom-[17px] after:h-[2px] after:bg-[var(--ruby)]" : "text-[var(--ink2)] hover:text-[var(--ink)]"}`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden lg:contents">
            {tx.state.busy && <span className="text-xs text-[var(--muted)]">{tx.state.message}</span>}
            {!tx.state.busy && tx.state.message && <span className="text-xs text-[var(--sage)]">{tx.state.message}</span>}
            {tx.state.error && <span className="max-w-[240px] truncate text-xs text-[var(--rose)]">{tx.state.error}</span>}
          </span>
          <span className="engraved hidden text-[10px] text-[var(--muted)] md:inline">Sepolia</span>
          {isConnected && !wrongChain && (
            <button className="btn btn-light !rounded-full" disabled={tx.state.busy} onClick={faucet} title="Mint free test tokens: one transaction">
              <Droplets className="h-4 w-4" /> <span className="hidden sm:inline">Faucet</span>
            </button>
          )}
          {wrongChain ? (
            <button className="btn btn-dark !rounded-full" onClick={() => switchChain({ chainId: sepolia.id })}>
              Switch to Sepolia
            </button>
          ) : isConnected ? (
            <button className="btn btn-light !rounded-full" onClick={() => disconnect()} title="Disconnect">
              <Wallet className="h-4 w-4" />
              {address!.slice(0, 6)}…{address!.slice(-4)}
            </button>
          ) : (
            <button className="btn btn-dark !rounded-full" disabled={isPending} onClick={() => connect({ connector: connectors[0] })}>
              Connect
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
