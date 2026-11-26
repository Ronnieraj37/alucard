/**
 * Gas limit to send for an estimate made a moment before the transaction lands.
 *
 * Between the estimate and the block, a swap in one of our pools can take a longer path: the hook writes a price
 * snapshot in the first swap of each minute (~45-70k gas) and fills limit orders the price has crossed (~80k each,
 * see test/FillGas.t.sol). A plain multiplier is too small for cheap calls, so the room is a base of BASE gas, or 30%
 * of the estimate when that is more. Only the gas used is paid.
 */
export const BASE = 150_000n;

export function withHeadroom(estimate: bigint): bigint {
  const pct = (estimate * 3n) / 10n;
  return estimate + (pct > BASE ? pct : BASE);
}
