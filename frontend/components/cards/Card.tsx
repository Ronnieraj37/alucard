"use client";

import { forwardRef, type CSSProperties, type ReactNode } from "react";
import { SUITS, type Suit } from "@/lib/suits";

// A rule card. Front: the suit, the rule's name, and what it does in plain words. Back (when flipped): whatever the
// parent passes, such as a backtest or the on-chain fields. Face down: the deck's back, red with the mirrored mark.

export type CardSize = "sm" | "md" | "lg";

type Props = {
  suit: Suit;
  title: string;
  when?: string;
  then?: string;
  size?: CardSize;
  flipped?: boolean;
  faceDown?: boolean;
  back?: ReactNode;
  footer?: ReactNode;
  className?: string;
  style?: CSSProperties;
};

const W: Record<CardSize, number> = { sm: 150, md: 210, lg: 260 };

const Card = forwardRef<HTMLDivElement, Props>(function Card(
  { suit, title, when, then, size = "md", flipped = false, faceDown = false, back, footer, className = "", style },
  ref,
) {
  const s = SUITS[suit];
  const turned = flipped || faceDown;
  return (
    <div ref={ref} className={`ac-card ac-${size} ${className}`} style={{ width: W[size], ["--suit" as string]: s.color, ["--tint" as string]: s.tint, ...style }}>
      <div className="ac-inner" style={{ transform: turned ? "rotateY(180deg)" : undefined }}>
        <div className="ac-face ac-front">
          <span className="ac-index">
            <b>{s.pip}</b>
            <i>{s.name}</i>
          </span>
          <span className="ac-index ac-index-flip" aria-hidden="true">
            <b>{s.pip}</b>
            <i>{s.name}</i>
          </span>
          <div className="ac-body">
            <span className="ac-pip" aria-hidden="true">
              {s.pip}
            </span>
            <h4 className="ac-title">{title}</h4>
            {when && (
              <p className="ac-line">
                <span>When</span> {when}
              </p>
            )}
            {then && (
              <p className="ac-line">
                <span>Then</span> {then}
              </p>
            )}
            {footer}
          </div>
        </div>
        <div className={`ac-face ${faceDown ? "ac-back-deck" : "ac-back"}`}>{faceDown ? <DeckBack /> : back}</div>
      </div>
    </div>
  );
});

export default Card;

/** The back of every card: deep red, and a mark that reads ALUCARD one way and, mirrored, DRACULA the other. */
export function DeckBack() {
  return (
    <div className="ac-deck">
      <div className="ac-deck-frame">
        <span className="ac-deck-word">ALUCARD</span>
        <span className="ac-deck-pips">♠ ♦ ♣ ♥</span>
        <span className="ac-deck-word ac-deck-mirror" aria-hidden="true">
          ALUCARD
        </span>
      </div>
    </div>
  );
}
