// Pure classification for the swap reconciler, split out so it carries no heavy
// imports (prover / wasm) and can be unit-tested in isolation. See
// swapReconcile.ts for how each verdict is acted on.

// A swap younger than this may still be in flight; do not touch it. Matches the
// page-side swap timeout budget with headroom.
export const RESUME_GRACE_MS = 120_000
// Below this the fresh address never received the withdraw (only rent dust), so
// the input note is still unspent and safe in the pool. Mirrors the swap
// overhead reserve in privateSwap.
export const RESUME_MIN_LAMPORTS = 6_000_000n

/** Wrapped-SOL mint. The swaps app sends this as `outputMint` for a SOL output
 *  (not the literal "SOL"), and Jupiter unwraps it to native SOL on the way out.
 *  Both spellings must count as native SOL so a token->SOL round trip re-shields
 *  a native note (and displays as SOL) instead of mis-handling it as an SPL. */
export const WSOL_MINT = "So11111111111111111111111111111111111111112"

/** True when `outputMint` denotes native SOL (the literal "SOL" or the wrapped
 *  mint). Kept here (no heavy imports) so it is unit-testable. */
export function isNativeSolOutput(mint: string): boolean {
  return mint === "SOL" || mint === WSOL_MINT
}

/** True when `mint` denotes an SPL token (neither the literal "SOL" nor WSOL). */
export function isTokenInput(mint?: string): boolean {
  if (!mint) return false
  return !isNativeSolOutput(mint)
}

export type StrandAction = "skip" | "resume" | "landed" | "unresolved"

/// Decide what to do with a stranded swap row from its on-chain footprint.
///  - skip:       already recorded, or still inside the in-flight grace window.
///  - resume:     the fresh address holds swappable funds (SOL or input token) → finish the swap leg.
///  - landed:     input is gone but the bought token sits there → record it done.
///  - unresolved: nothing recoverable → leave for the user to dismiss manually.
export function classifyStrand(args: {
  hasSignature: boolean
  ageMs: number
  solLamports: bigint
  tokenAmount: bigint
  isTokenInput?: boolean
  inputTokenAmount?: bigint
}): StrandAction {
  if (args.hasSignature) return "skip"
  if (args.ageMs < RESUME_GRACE_MS) return "skip"
  if (args.isTokenInput) {
    if ((args.inputTokenAmount ?? 0n) > 0n) return "resume"
    if (args.tokenAmount > 0n) return "landed"
    return "unresolved"
  }
  if (args.solLamports > RESUME_MIN_LAMPORTS) return "resume"
  if (args.tokenAmount > 0n) return "landed"
  return "unresolved"
}
