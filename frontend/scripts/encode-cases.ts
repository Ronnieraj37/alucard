// Prints the frontend's contract encoding (encodeRules) for a set of rules on two pools with opposite orientation,
// so lp_study/tests/test_rules_backtest.py can check the Python engine encodes them the same way.
import { POOLS } from "../lib/pools";
import { encodeRules, type Rules } from "../lib/rules";

const cases: Record<string, Rules> = {
  takeProfit: { down: { trigger: null, actions: [], repeat: false }, up: { trigger: { kind: "leave", bufferPct: 0 }, actions: [{ kind: "withdraw", pct: 100 }], repeat: false } },
  stopLoss: {
    down: { trigger: { kind: "leave", bufferPct: 2 }, actions: [{ kind: "withdraw", pct: 100 }, { kind: "convert", to: "quote" }], repeat: false },
    up: { trigger: null, actions: [], repeat: false },
  },
  convertToBase: {
    down: { trigger: null, actions: [], repeat: false },
    up: { trigger: { kind: "leave", bufferPct: 0 }, actions: [{ kind: "withdraw", pct: 50 }, { kind: "convert", to: "base" }], repeat: false },
  },
  follow: {
    down: { trigger: { kind: "leave", bufferPct: 0 }, actions: [{ kind: "follow", widthPct: 5 }], repeat: true },
    up: { trigger: { kind: "leave", bufferPct: 3 }, actions: [{ kind: "follow", widthPct: 8 }], repeat: true },
  },
  compound: { down: { trigger: null, actions: [], repeat: false }, up: { trigger: { kind: "timer", hours: 6 }, actions: [{ kind: "readd" }], repeat: true } },
  collect: { down: { trigger: { kind: "timer", hours: 24 }, actions: [{ kind: "collect" }], repeat: true }, up: { trigger: null, actions: [], repeat: false } },
  ladder: { down: { trigger: null, actions: [], repeat: false }, up: { trigger: { kind: "price", price: 0 }, actions: [{ kind: "withdraw", pct: 25 }], repeat: true, stepPct: 3 } },
  trailingStop: {
    down: { trigger: { kind: "trail", trailPct: 5 }, actions: [{ kind: "withdraw", pct: 100 }, { kind: "convert", to: "quote" }], repeat: false },
    up: { trigger: null, actions: [], repeat: false },
  },
  trailUp: { down: { trigger: null, actions: [], repeat: false }, up: { trigger: { kind: "trail", trailPct: 3 }, actions: [{ kind: "withdraw", pct: 100 }], repeat: false } },
  confirmedStop: {
    down: { trigger: { kind: "leave", bufferPct: 0 }, actions: [{ kind: "withdraw", pct: 100 }], repeat: false, holdMinutes: 30 },
    up: { trigger: null, actions: [], repeat: false },
  },
  leaveAndTimer: {
    down: { trigger: { kind: "leave", bufferPct: 1 }, trigger2: { kind: "timer", hours: 6 }, combine: "and", actions: [{ kind: "withdraw", pct: 100 }], repeat: false },
    up: { trigger: null, actions: [], repeat: false },
  },
  priceOrTimer: {
    down: { trigger: null, actions: [], repeat: false },
    up: { trigger: { kind: "price", price: 0 }, trigger2: { kind: "timer", hours: 24 }, combine: "or", actions: [{ kind: "withdraw", pct: 25 }], repeat: true, stepPct: 2, maxRuns: 4 },
  },
  chainlinkStop: {
    down: { trigger: { kind: "oracle", price: 0 }, actions: [{ kind: "withdraw", pct: 100 }, { kind: "convert", to: "quote" }], repeat: false },
    up: { trigger: null, actions: [], repeat: false },
  },
  chainlinkLadder: {
    down: { trigger: null, actions: [], repeat: false },
    up: { trigger: { kind: "oracle", price: 0 }, actions: [{ kind: "withdraw", pct: 25 }], repeat: true, stepPct: 3, maxRuns: 4 },
  },
  poolAndChainlink: {
    down: { trigger: { kind: "price", price: 0 }, trigger2: { kind: "oracle", price: 0 }, combine: "and", actions: [{ kind: "withdraw", pct: 100 }], repeat: false },
    up: { trigger: null, actions: [], repeat: false },
  },
  bracket: {
    down: { trigger: { kind: "price", price: 0 }, actions: [{ kind: "withdraw", pct: 100 }, { kind: "convert", to: "quote" }], repeat: false },
    up: { trigger: { kind: "price", price: 0 }, actions: [{ kind: "withdraw", pct: 100 }], repeat: false },
  },
};

const out: unknown[] = [];
for (const name of ["WETH_USDC_3000", "LINK_WETH_10000"]) {
  const pool = POOLS.find((p) => p.name === name)!;
  // reference prices for the price triggers (any positive value works; both sides use the same)
  const price = pool.base.symbol === "WETH" ? 2000 : 0.005;
  for (const [id, r] of Object.entries(cases)) {
    const rules: Rules = JSON.parse(JSON.stringify(r));
    const level = (k?: string) => k === "price" || k === "oracle";
    if (level(rules.down.trigger?.kind)) rules.down.trigger!.price = price * 0.9;
    if (level(rules.up.trigger?.kind)) rules.up.trigger!.price = price * 1.1;
    if (level(rules.down.trigger2?.kind)) rules.down.trigger2!.price = price * 0.95;
    if (level(rules.up.trigger2?.kind)) rules.up.trigger2!.price = price * 1.05;
    out.push({
      pool: name,
      token0: pool.token0.symbol,
      token1: pool.token1.symbol,
      dec0: pool.token0.decimals,
      dec1: pool.token1.decimals,
      spacing: pool.key.tickSpacing,
      case: id,
      rules,
      encoded: encodeRules(pool, rules),
    });
  }
}
console.log(JSON.stringify(out));
