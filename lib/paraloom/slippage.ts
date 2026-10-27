// Slippage tolerance for private swaps.
//
// Deliberately dependency-free: the approval screen, the background swap job and
// the router request all have to agree on one number, and the unit test for the
// clamp must load without dragging in @solana/web3.js.

/** Default tolerance (1%) when the caller does not ask for one. */
export const DEFAULT_SLIPPAGE_BPS = 100

/** Ceiling for a caller-supplied tolerance (10%), so a page cannot ask for the moon. */
export const MAX_SLIPPAGE_BPS = 1_000

/**
 * Clamp a page-supplied tolerance into a sane range. Absent, non-finite or
 * non-numeric input falls back to the default; the value is rounded and held
 * between 1 bps and MAX_SLIPPAGE_BPS. Used by the background before the router
 * request and by the approval screen, so the number shown is the number sent.
 */
export function effectiveSlippageBps(requested?: number): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return DEFAULT_SLIPPAGE_BPS
  }
  return Math.min(MAX_SLIPPAGE_BPS, Math.max(1, Math.round(requested)))
}
