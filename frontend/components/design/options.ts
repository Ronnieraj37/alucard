// What a rule can be made of: the same pieces the rule editor offers (lib/rules.ts), in plain words.
export const WHEN = [
  "WETH falls 5% from its high",
  "the price leaves your range",
  "WETH reaches $2,400",
  "Chainlink says WETH is below $1,950",
  "the WBTC pool's price passes a level",
  "24 hours have passed",
];
export const JOIN = ["and", "or"];
export const WHEN2 = ["it stays there for 30 minutes", "Chainlink agrees", "WETH is above $1,800"];
export const THEN = [
  "withdraw everything",
  "withdraw 25%",
  "collect the fees",
  "convert it all to USDC",
  "re-add it in the same range",
  "move the range next to the price",
];
export const THEN2 = ["convert to USDC", "keep the fees", "put the fees back in", "convert to WETH"];
export const REPEAT = ["once", "every time, up to 4 times", "every 5% step", "until you cancel"];
export const LIMITS = ["keeper fee at most 0.1%", "slippage at most 1%", "expires in 30 days"];

export const MENU = {
  conditions: ["Leaves the range", "Trailing high", "Price level", "Chainlink price", "Another pool's price", "Timer"],
  combine: ["and", "or", "hold for N minutes"],
  actions: ["Collect fees", "Withdraw some or all", "Convert to one token", "Re-add, same range", "Follow the price"],
  repeat: ["Once", "Repeat with steps", "Up to N runs"],
  limits: ["Keeper fee cap", "Slippage", "Expiry"],
};

/** Distinct rule shapes the editor can build, each checked against the contract (EditorParity test). */
export const RULE_SHAPES = 79682;
