"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";

// Pages that read nothing chain-specific in their first render: they render on the server too, so their text is in
// the HTML (search engines, link previews, reading tools).
const STATIC = (path: string) => path === "/" || path.startsWith("/docs") || path.startsWith("/slides");

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchInterval: 12_000 } } }));
  const path = usePathname() ?? "/";
  // The app pages draw the chosen network's deployment, which lives in the browser (localStorage): those render in
  // the browser only, so the server and the first browser render agree.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={client}>{mounted || STATIC(path) ? children : null}</QueryClientProvider>
    </WagmiProvider>
  );
}
