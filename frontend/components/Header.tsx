"use client";

import { Check, ChevronDown, Droplets, Wallet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { APP_NAME } from "@/lib/brand";
import { Mark } from "@/components/night/NightLanding";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type Abi } from "viem";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { CHAIN_ID, CHAINS, type ChainId, SUPPORTED, setChain } from "@/lib/chain";
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
  // the app follows the wallet onto any network we are deployed on; anywhere else, it asks to switch
  const walletSupported = !!chainId && SUPPORTED.includes(chainId as ChainId);
  const wrongChain = isConnected && !walletSupported;
  useEffect(() => {
    if (isConnected && walletSupported && chainId !== CHAIN_ID) setChain(chainId as ChainId);
  }, [isConnected, walletSupported, chainId]);

  // the landing page and the pitch deck have their own navigation
  if (path === "/" || path.startsWith("/slides")) return null;

  // One transaction: the faucet contract mints every test token to the caller.
  const faucet = () =>
    tx.run(async () => {
      await tx.send("Get test tokens", { address: CORE.faucet, abi: faucetAbi as Abi, functionName: "drip", args: [] });
    }, "Added 100 tWETH, 5 tWBTC, 500k tUSDC/tUSDT/tDAI, 20k tLINK");

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-[var(--paper)]/95">
      <div className="mx-auto flex h-16 max-w-[1200px] items-center gap-3 px-4 sm:gap-6">
        <Link href="/" className="flex items-center gap-2.5">
          <Mark size={28} />
          <span className="engraved hidden text-[17px] tracking-[0.16em] sm:inline">{APP_NAME}</span>
        </Link>
        <nav className="flex gap-1">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`relative px-2 py-1.5 text-[15px] sm:px-3 ${path.startsWith(n.href) ? "text-[var(--ink)] after:absolute after:inset-x-3 after:-bottom-[17px] after:h-[2px] after:bg-[var(--glow)] after:shadow-[0_0_12px_var(--glow)]" : "text-[var(--ink2)] hover:text-[var(--ink)]"}`}
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
          <NetworkMenu
            onPick={(id) => {
              if (isConnected) switchChain({ chainId: id }); // the wallet moves, then the app follows it
              else setChain(id);
            }}
          />
          {isConnected && !wrongChain && (
            <button className="btn btn-light !rounded-full" disabled={tx.state.busy} onClick={faucet} title="Mint free test tokens: one transaction">
              <Droplets className="h-4 w-4" /> <span className="hidden sm:inline">Faucet</span>
            </button>
          )}
          {wrongChain ? (
            <button className="btn btn-dark !rounded-full" onClick={() => switchChain({ chainId: CHAIN_ID })}>
              Switch to {CHAINS[CHAIN_ID].short}
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

/** The network the app is on, and the others it is deployed on. */
function NetworkMenu({ onPick }: { onPick: (id: ChainId) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button className="net-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} title="Network">
        <NetDot id={CHAIN_ID} />
        <span className="hidden sm:inline">{CHAINS[CHAIN_ID].short}</span>
        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
      </button>
      {open && (
        <div className="net-menu" role="menu">
          <p className="net-menu-h">Network</p>
          {SUPPORTED.map((id) => (
            <button
              key={id}
              role="menuitem"
              className="net-item"
              onClick={() => {
                setOpen(false);
                if (id !== CHAIN_ID) onPick(id);
              }}
            >
              <NetDot id={id} />
              <span className="flex-1 text-left">{CHAINS[id].label}</span>
              {id === CHAIN_ID && <Check className="h-4 w-4 text-[var(--glow)]" />}
            </button>
          ))}
          <p className="net-menu-f">Testnets. Each has its own pools and test tokens.</p>
        </div>
      )}
    </div>
  );
}

function NetDot({ id }: { id: ChainId }) {
  return <span className="net-dot" style={{ background: id === 1301 ? "#f50db4" : "#627eea" }} aria-hidden="true" />;
}
