import type { Metadata } from "next";
import Deck from "@/components/slides/Deck";
import "@/components/watch/watch.css";

export const metadata: Metadata = { title: "Alucard · Pitch" };

export default function SlidesPage() {
  return <Deck />;
}
