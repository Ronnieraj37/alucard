"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import VariantA from "./VariantA";
import VariantB from "./VariantB";
import VariantC from "./VariantC";

const VARIANTS = [
  { id: "a", name: "A · Write your rule", note: "The rule is a sentence; every part is a choice", C: VariantA },
  { id: "b", name: "B · Rules on the chart", note: "Drag exits onto the real price history", C: VariantB },
  { id: "c", name: "C · Building blocks", note: "When and then blocks you stack and swap", C: VariantC },
];

export default function DesignPicker() {
  const [v, setV] = useState("a");
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("v");
    if (q && VARIANTS.some((x) => x.id === q)) setV(q);
  }, []);
  const pick = (id: string) => {
    setV(id);
    window.history.replaceState(null, "", `/design?v=${id}`);
    window.scrollTo({ top: 0 });
  };
  const cur = VARIANTS.find((x) => x.id === v)!;
  return (
    <div className="table-page min-h-screen">
      <header className="fixed inset-x-0 top-0 z-40 border-b border-black/5 bg-[#eef0f2]/85 backdrop-blur-md">
        <nav className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-5">
          <span className="t-display text-[22px] leading-none max-sm:hidden">Alucard</span>
          <div className="flex gap-1 rounded-xl bg-white/80 p-1 text-[13px] shadow-[0_0_0_1px_rgba(0,0,0,0.06)]">
            {VARIANTS.map((x) => (
              <button key={x.id} onClick={() => pick(x.id)} title={x.note} className={`rounded-lg px-3 py-1.5 ${x.id === v ? "bg-[#17181c] font-semibold text-white" : "text-[#5b5e68] hover:text-black"}`}>
                <span className="sm:hidden">{x.id.toUpperCase()}</span>
                <span className="max-sm:hidden">{x.name}</span>
              </button>
            ))}
          </div>
          <Link href="/swap" className="t-btn t-btn-dark ml-auto !h-10 !px-4 !text-[14px] max-md:hidden">
            Open the app <ArrowRight className="h-4 w-4" />
          </Link>
        </nav>
      </header>
      <cur.C key={v} />
    </div>
  );
}
