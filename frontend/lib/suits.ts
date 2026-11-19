// Every rule is a card, and every card has a suit: what the rule is for.
import type { Lane, LaneId } from "./rules";

export type Suit = "protect" | "profit" | "follow" | "grow";

/** A four-colour deck, as in poker: four suits that never get confused, even small. */
export const SUITS: Record<Suit, { pip: string; name: string; job: string; color: string; tint: string }> = {
  protect: { pip: "♠", name: "Protect", job: "Limit a loss", color: "#17181c", tint: "#eceef2" },
  profit: { pip: "♦", name: "Profit", job: "Lock in a gain", color: "#1f5fd6", tint: "#e8effc" },
  follow: { pip: "♣", name: "Follow", job: "Stay in range", color: "#167a4a", tint: "#e5f3ec" },
  grow: { pip: "♥", name: "Grow", job: "Keep earning", color: "#d0223a", tint: "#fbe9ec" },
};

export const SUIT_ORDER: Suit[] = ["protect", "profit", "follow", "grow"];

/** The suit of one side of a position's rules. */
export function suitOf(id: LaneId, lane: Lane): Suit {
  const kinds = lane.actions.map((a) => a.kind);
  if (kinds.includes("follow")) return "follow";
  const exits = kinds.includes("withdraw") || kinds.includes("convert");
  if (!exits && (kinds.includes("readd") || kinds.includes("collect"))) return "grow";
  return id === "down" ? "protect" : "profit";
}
