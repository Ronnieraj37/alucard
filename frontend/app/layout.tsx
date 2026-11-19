import type { Metadata } from "next";
import { Archivo, Geist, Geist_Mono, Marcellus } from "next/font/google";
import "./globals.css";
import { APP_NAME, TAGLINE } from "@/lib/brand";
import { Providers } from "./providers";
import Header from "@/components/Header";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });
const archivo = Archivo({ subsets: ["latin"], variable: "--font-archivo" });
const marcellus = Marcellus({ subsets: ["latin"], weight: "400", variable: "--font-marcellus" });

export const metadata: Metadata = {
  title: `${APP_NAME}: ${TAGLINE}`,
  description: "Add rules to your Uniswap v4 liquidity: take profit, stop loss, follow the price, compound. Limit orders too.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable} ${archivo.variable} ${marcellus.variable}`}>
      <body>
        <Providers>
          <Header />
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  );
}
