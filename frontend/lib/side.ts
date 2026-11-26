// One side of an order packed into the 256-bit word ConditionalOrders takes and stores. Mirrors
// src/libraries/OrderState.sol bit for bit (test/EditorParity.t.sol checks it against the contract).

export type Side = {
  edge: number;
  checker: number;
  value: number;
  checkPool: number;
  actions: number;
  removeBps: number;
  swapToToken1: boolean;
  addMode: number;
  repeat: boolean;
  shape: number;
  lastRun: number; // unix seconds (rounded up to the minute in storage)
  checker2: number;
  value2: number;
  checkPool2: number;
  combine: number;
  holdMinutes: number;
  best: number;
  runsLeft: number;
};

export const offSide = (): Side => ({
  edge: 0,
  checker: 0,
  value: 0,
  checkPool: 0,
  actions: 0,
  removeBps: 0,
  swapToToken1: false,
  addMode: 0,
  repeat: false,
  shape: 0,
  lastRun: 0,
  checker2: 0,
  value2: 0,
  checkPool2: 0,
  combine: 0,
  holdMinutes: 0,
  best: 0,
  runsLeft: 0,
});

/** 2026-01-01 00:00:00 UTC: stored times are minutes after this. */
export const BASE_TIME = 1_767_225_600;

const u24 = (v: number) => BigInt(v < 0 ? v + 0x1000000 : v) & 0xffffffn;
const s24 = (v: bigint) => {
  const x = Number(v & 0xffffffn);
  return x >= 0x800000 ? x - 0x1000000 : x;
};
const bit = (b: boolean) => (b ? 1n : 0n);
const minutes = (t: number) => (t === 0 ? 0n : BigInt(Math.max(1, Math.ceil((t - BASE_TIME) / 60))));
const time = (m: bigint) => (m === 0n ? 0 : BASE_TIME + Number(m) * 60);

export function encodeSide(d: Side): bigint {
  return (
    u24(d.edge) |
    (BigInt(d.checker & 0x3f) << 24n) |
    (u24(d.value) << 30n) |
    (BigInt(d.checkPool) << 54n) |
    (BigInt(d.checker2 & 0x3f) << 78n) |
    (u24(d.value2) << 84n) |
    (BigInt(d.checkPool2) << 108n) |
    (BigInt(d.combine & 3) << 132n) |
    (BigInt(d.holdMinutes & 0xffff) << 134n) |
    (minutes(d.lastRun) << 150n) |
    (u24(d.best) << 174n) |
    (BigInt(d.actions & 0x1f) << 198n) |
    (BigInt(d.removeBps & 0x3fff) << 206n) |
    (bit(d.swapToToken1) << 220n) |
    (BigInt(d.addMode & 7) << 221n) |
    (bit(d.repeat) << 224n) |
    (BigInt(d.runsLeft & 0x7f) << 225n) |
    (BigInt(d.shape & 0x3fffff) << 232n)
  );
}

export function decodeSide(v: bigint): Side {
  return {
    edge: s24(v),
    checker: Number((v >> 24n) & 0x3fn),
    value: s24(v >> 30n),
    checkPool: Number((v >> 54n) & 0xffffffn),
    checker2: Number((v >> 78n) & 0x3fn),
    value2: s24(v >> 84n),
    checkPool2: Number((v >> 108n) & 0xffffffn),
    combine: Number((v >> 132n) & 3n),
    holdMinutes: Number((v >> 134n) & 0xffffn),
    lastRun: time((v >> 150n) & 0xffffffn),
    best: s24(v >> 174n),
    actions: Number((v >> 198n) & 0x1fn),
    removeBps: Number((v >> 206n) & 0x3fffn),
    swapToToken1: ((v >> 220n) & 1n) === 1n,
    addMode: Number((v >> 221n) & 7n),
    repeat: ((v >> 224n) & 1n) === 1n,
    runsLeft: Number((v >> 225n) & 0x7fn),
    shape: Number((v >> 232n) & 0x3fffffn),
  };
}

// ---------------------------------------------------------------- contract constants

export const CHECK = { OFF: 0, EDGE: 1, TICK: 2, TIME: 3, TRAIL: 4, FEES: 6, APR: 7 } as const; // 5 is retired
export const ACT = { KEEP_FEES: 1, REMOVE: 2, SWAP: 4, ADD: 8, MOVE: 16 } as const;
export const COMBINE = { NONE: 0, AND: 1, OR: 2 } as const;
export const ADD_SAME = 0;
export const ADD_CENTERED = 1;
export const LEG = { NONE: 0, IDLE: 1, RANGE: 2, CENTERED: 3 } as const;

/** A leg of a two-leg strategy (OrderState.Leg). */
export type Leg = { poolIndex: number; kind: number; a: number; b: number };
export const noLeg = (): Leg => ({ poolIndex: 0, kind: 0, a: 0, b: 0 });
