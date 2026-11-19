---
name: Alucard
description: Rules inside a Uniswap v4 position, drawn as a watchmaker's technical catalogue.
colors:
  paper: "#f3f4f5"
  enamel: "#fbfbfc"
  ink: "#1b1d22"
  ink-2: "#474b54"
  ink-3: "#6c707a"
  hair: "#c6cad1"
  ruby: "#a3122a"
  gilt: "#9a7a45"
  brass: "#d7c39a"
  blued-steel: "#2c4f8f"
  steel: "#e2e5e9"
  steel-2: "#b8bec7"
typography:
  display:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(3rem, 6.2vw, 5.6rem)"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(2.4rem, 4.4vw, 3.8rem)"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "-0.035em"
  title:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "24px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "-0.02em"
  lead:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 400
    lineHeight: 1.625
  body:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.55
    fontFeature: "tnum"
  label:
    fontFamily: "Marcellus, Georgia, serif"
    fontSize: "12px"
    fontWeight: 400
    letterSpacing: "0.22em"
  measure:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
  dial-numeral:
    fontFamily: "Archivo, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 500
    fontFeature: "tnum, lnum"
rounded:
  plate: "4px"
  field: "6px"
  pill: "999px"
spacing:
  gutter: "20px"
  row: "12px"
  block: "56px"
  section: "112px"
  nav: "64px"
components:
  button-ink:
    backgroundColor: "{colors.ink}"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
    padding: "0 24px"
    height: "52px"
  button-ink-hover:
    backgroundColor: "{colors.ruby}"
    textColor: "#ffffff"
  button-line:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 24px"
    height: "52px"
  button-step:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    size: "36px"
  nav-bar:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-2}"
    height: "64px"
  certificate:
    backgroundColor: "{colors.enamel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.plate}"
    padding: "48px"
  status-window:
    backgroundColor: "#ffffff"
    textColor: "{colors.ink}"
    rounded: "{rounded.plate}"
    typography: "{typography.dial-numeral}"
---

# Design System: Alucard

## Overview

**Creative North Star: "The Watchmaker's Catalogue"**

Alucard is drawn as a plate from a technical catalogue of fine watchmaking: cool white paper, graphite linework, and a working automatic movement whose bridges are engraved with the parts of a rule. The object does the explaining. Each viewport holds one drawn instrument (the movement, the dial, the caseback, the certificate) beside a short column of plain prose, and everything that moves moves the way a mechanism moves: wheels at their gear ratios, a balance swinging, hands that spring to a value and settle.

Density is low and deliberate. Sections are separated by a single hairline and long vertical air, never by cards or tinted panels. Colour is almost entirely neutral graphite on paper; the warmth comes from material colours inside the drawings (gilt, brass, blued screws), and a single ruby red marks jewels and the moment a rule acts. Type pairs a tight grotesque for statements with an engraved Roman capital for labels, the way a dial pairs numerals with its signature.

This world was built to refuse the DeFi landing default: no dark hero, no gradient glow, no glass panels, no stat rows, no feature-card grids.

**Key Characteristics:**
- Cool paper ground with graphite ink; depth from linework, not fills.
- One drawn instrument per viewport, rendered as authored SVG, never as a raster or 3D render.
- Ruby is scarce and semantic: jewels, the stop, the set point, and "it ran".
- Engraved small capitals label the drawings; prose stays sentence case.
- Motion is mechanical only and stops entirely under reduced motion.

## Colors

A graphite-on-paper palette with one jewel red and the material colours of a watch movement.

### Primary
- **Ruby Jewel** (ruby): the one accent. Jewels at every pivot, pallet stones, the stop marker and set-point hand on the dial, the status window when it reads "RAN", the checked radio, focus rings, text selection, the primary button's hover, and the result column of the certificate.

### Secondary
- **Engraver's Gilt** (gilt): hairline gold for engraving. Bridge labels, the dial signature, the position's range arc on the dial, wheel and balance outlines. Used as line and lettering, never as a fill area.
- **Blued Steel** (blued-steel): screws and the hairspring only. A material colour, not a UI colour.

### Tertiary
- **Brass** (brass): jewel settings (chatons) and the brass of the wheel train. Lives inside the drawings and the favicon.

### Neutral
- **Catalogue Paper** (paper): the page ground and the sticky nav (at 90% with a light blur).
- **Enamel White** (enamel): watch cases, dial faces, subdials, slider thumbs, and the alternating section band (Configure, Certificate). The only surface tint in the system.
- **Graphite Ink** (ink): headlines, primary button fill, dial hands, tick marks, the bottom rule of the certificate header, the range track.
- **Soft Graphite** (ink-2): body prose, nav links, bridge outlines, unselected options.
- **Pencil Grey** (ink-3): captions, footnotes, engraved HTML labels, footer text.
- **Hairline** (hair): every divider, section rule, ghost button outline, subdial ticks, link underlines at rest.
- **Polished Steel** (steel) and **Shadowed Steel** (steel-2): bridge and plate fills, the crown, caseback screws, unchecked radio outline, scrollbar.

### Named Rules
**The One Jewel Rule.** Ruby marks a pivot or the moment a rule acts. If removing the red would not lose meaning, it should not be red.

**The Material Colour Rule.** Gilt, brass and blued steel belong to the drawn mechanism. They never fill a button, a band, or a panel.

## Typography

**Display Font:** Archivo (with Helvetica Neue, Arial)
**Body Font:** Geist (with system-ui)
**Label Font:** Marcellus (with Georgia), set as engraving
**Mono Font:** Geist Mono, for contract fields only

**Character:** A compact grotesque at weight 500 with tight negative tracking states things plainly; the engraved Roman capitals of Marcellus, widely spaced, read as lettering cut into metal. Numerals are tabular throughout so prices and counts do not jitter as they change.

### Hierarchy
- **Display** (500, clamp 3rem to 5.6rem, line-height 1, tracking -0.035em, balanced wrap): the hero statement only.
- **Headline** (500, clamp 2.4rem to 3.8rem): one per section. The closing line steps up to clamp 2.6rem to 4.4rem; the certificate steps down to clamp 2rem to 3rem.
- **Title** (500, 24px, tracking -0.02em): statement terms in definition lists (the sealed-case claims); large figures in the certificate at 26px.
- **Lead** (19px, relaxed leading, max 34rem): the paragraph under the hero and the plain-words rule sentence. Section intros sit at 18px, max about 36rem.
- **Body** (17px, 1.55): default. Footnotes and captions at 13-14px in pencil grey.
- **Label** (Marcellus 400, 12px, tracking 0.22em, uppercase): fieldset legends and the certificate's issuing line in HTML. Inside drawings the same face is set at 15-22px with 0.32-0.34em tracking, in gilt.
- **Measure** (Geist Mono 13px): the revealed on-chain fields, nothing else.
- **Dial numeral** (Archivo 500, tabular and lining figures): scale numbers, subdial values, and the status window.

### Named Rules
**The Engraving Rule.** Spaced capitals are reserved for things that would be engraved on a movement: part names, the signature, legends that name a mechanism (When, Then). Headlines and prose are always sentence case.

**The Plain Words Rule.** Contract field names appear only in Geist Mono and only behind an explicit reveal. The visible layer is plain English.

## Layout

A single centred container of 72rem with a 20px side gutter, under a 64px sticky nav with a hairline bottom border. Each section is a two-column split on wide screens: one fixed-width instrument column (560px for the hero movement, 520px for the replay dial, 440px for the configurator dial and the caseback) against a fluid prose column, separated by a 48-56px gap. Sections are spaced with 112px of vertical padding and divided by one hairline rule; Configure and Certificate sit on the enamel band to alternate rhythm without boxing.

The hero and the replay fill the viewport height below the nav on wide screens. The replay is pinned for 320vh of scroll: the first 18% turns the watch over (movement to dial, a Y-axis flip with hidden backfaces) and the rest scrubs the backtest. Below 1024px the pin is dropped, the drawing moves above the text, shrinks to 250px (420px from 640px), and the replay plays itself while in view. Option lists are hairline-ruled rows (12px vertical padding), not tiles. Breakpoints follow 640, 768 and 1024px.

**The One Object Rule.** A viewport holds one drawn instrument. Never place two drawings side by side or add supporting graphics beside one.

## Elevation & Depth

The page is flat paper. Depth belongs to the drawings: the watch case carries one soft drop shadow so the object sits on the page, and everything else inside the drawing gets its depth from linework, Geneva stripes, perlage and a white bevel highlight. In the HTML layer, depth is limited to the primary button's short soft shadow and a slider thumb lift; outlines are drawn as inset 1px shadows so they never shift layout.

### Shadow Vocabulary
- **Case drop** (`drop-shadow(0 18px 30px rgba(27, 29, 34, 0.16))`): the outer case of every watch drawing. Only there.
- **Ink press** (`box-shadow: 0 6px 16px -6px rgba(27, 29, 34, 0.5)`): the primary ink button.
- **Hairline outline** (`box-shadow: inset 0 0 0 1px #c6cad1`): ghost buttons, step buttons, the select; darkens to ink on hover.
- **Certificate border** (`box-shadow: 0 0 0 1px #c6cad1, 0 0 0 7px #fbfbfc, 0 0 0 8px #c6cad1`): a double engraved rule around a document.

**The Paper Is Flat Rule.** Bands and text blocks never float. Only the watch object and the one action that opens the app carry a shadow.

## Shapes

Round where watches are round and pill-shaped where a finger presses; everything else is a ruled line. Buttons and step controls are full pills (999px). The certificate and the dial's status window use a near-square plate corner (4px). Focus rings and the select use a 6px field corner; checkboxes 4px; radios are circles. All instruments are 600-unit circular drawings scaled responsively; their silhouette (case circle, crown at three o'clock) is the system's signature form.

## Components

### Buttons
Confident and quiet: graphite pills that turn ruby on hover.
- **Shape:** full pill (999px), 52px tall, 24px side padding, Geist 600 at 15px, icon gap 10px.
- **Ink (primary):** graphite fill, white text, the ink-press shadow, a trailing arrow. Used only for "Open the app". In the nav it compacts to 40px tall, 16px padding, 14px text.
- **Line (secondary):** transparent, graphite text, hairline inset outline that darkens to ink on hover.
- **Hover / Focus / Active:** background and outline colours ease over 0.2s; press scales to 0.97 on a 0.15s ease-out (cubic-bezier(0.22, 1, 0.36, 1)); focus is a 2px ruby outline offset 3px.
- **Step (− / +):** 36px circular ghost buttons beside a 28px display-type readout.

### Links
- Underlined with a hairline-coloured decoration offset 4px; the underline turns ruby on hover. Nav and footer links instead shift from soft graphite to ink.

### Inputs
- **Radio / checkbox:** 16px white disc with a steel-2 inset ring; checked becomes a ruby dot inside a white ring. Checkboxes take a 4px corner. Each option is a full-width label row ruled by a hairline.
- **Range (time scrubber):** a 2px graphite track with a 22px enamel thumb, 2px ink ring and a small lift shadow.
- **Select:** transparent, 6px corner, hairline inset outline, 40% opacity when disabled.

### Navigation
- Sticky 64px bar on paper at 90% with a light backdrop blur and a hairline bottom border. Wordmark in display type at 22px; four section links at 15px in soft graphite (hidden below 768px); compact ink button at the right.

### Certificate (signature)
- A document plate on enamel with the double engraved border, a graphite rule under its heading, hairline-ruled rows of claim, large display figure, and a ruby result. Collapses to a two-column grid per row on phones.

### The Dial (signature)
- A 600-unit SVG instrument: enamel face inside the case, a 300-degree price scale from seven to five o'clock with major numerals every 200, the position's range as a 7px gilt arc, a graphite price hand, a ruby stop marker and ruby set-point hand, two subdials and a status window in the lower wedge. Hands rotate with springs (stiffness 120 / damping 18 for the price hand, 90/16 for markers, 140/16 for the set point).
- With a crown at three o'clock it becomes the configurator: drag the crown vertically or focus it and use arrow keys; its knurling scrolls with each step. Always paired with visible − / + buttons and a live plain-words sentence.

### The Movement (signature)
- An authored automatic movement: steel bridges with Geneva stripes and engraved labels (When, Then, Limits, Keeper), a gilt wheel train turning at true ratios, a swinging balance with a blued hairspring, ruby jewels in brass chatons, blued screws, a rotor sweeping on a 14s ease, and an engraved ring of text.

## Do's and Don'ts

### Do:
- **Do** keep one drawn instrument per viewport, at a fixed column width beside fluid prose.
- **Do** reserve ruby for jewels, the stop, the set point, "RAN", focus, selection and the certificate's results.
- **Do** separate sections with a single hairline and 112px of padding; alternate with the enamel band, not with boxes.
- **Do** set engraving in Marcellus capitals with wide tracking (0.22em in HTML, 0.3em or more inside drawings).
- **Do** animate only as a mechanism would: continuous rotation at gear ratios, oscillation, springs that settle, and the scroll-driven turn-over. Stop all of it under reduced motion and show the final state.
- **Do** pair every drag interaction (the crown) with keyboard steps and visible buttons.
- **Do** keep numerals tabular everywhere a value changes.

### Don't:
- **Don't** use a dark hero, gradient glow, glass panels, stat rows or feature-card grids.
- **Don't** fill buttons, bands or panels with gilt, brass or blued steel.
- **Don't** render the mechanism as a raster, photo or 3D model; it is drawn linework.
- **Don't** set headlines or prose in capitals; capitals are engraving.
- **Don't** show contract field names outside the mono reveal.
- **Don't** add shadows to bands, rows or text blocks; only the case and the primary button carry one.
