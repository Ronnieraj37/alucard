import type { Metadata } from "next";
import { Archivo, Bodoni_Moda, DM_Sans, Geist, Geist_Mono, Marcellus } from "next/font/google";
import "./globals.css";
import "@/components/cards/cards.css";
import { APP_NAME, TAGLINE } from "@/lib/brand";
import { Providers } from "./providers";
import Header from "@/components/Header";

const sans = DM_Sans({ subsets: ["latin"], variable: "--font-sans" });
const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });
const archivo = Archivo({ subsets: ["latin"], variable: "--font-archivo" });
const marcellus = Marcellus({ subsets: ["latin"], weight: "400", variable: "--font-marcellus" });
const bodoni = Bodoni_Moda({ subsets: ["latin"], style: ["normal", "italic"], variable: "--font-bodoni" });

export const metadata: Metadata = {
  title: `${APP_NAME}: ${TAGLINE}`,
  description: "Add rules to your Uniswap v4 liquidity: take profit, stop loss, follow the price, compound. Limit orders too.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${geist.variable} ${geistMono.variable} ${bodoni.variable} ${archivo.variable} ${marcellus.variable}`}>
      <body>
        <Providers>
          <Header />
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  );
}
