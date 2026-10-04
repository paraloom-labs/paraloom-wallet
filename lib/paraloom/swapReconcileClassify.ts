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
// Gas SOL self-funded from shielded balance for token-input private swaps (0.009 SOL).
// Leftover gas below or equal to this must NEVER be mistaken for landed SOL output (#855).
export const GAS_LAMPORTS = 9_000_000n

/** Wrapped-SOL mint. The swaps app sends this as `outputMint` for a SOL output
 *  (not the literal "SOL"), and Jupiter unwraps it to native SOL on the way out.
 *  Both spellings must count as native SOL so a token->SOL round trip re-shields
 *  a native note (and displays as SOL) instead of mis-handling it as an SPL. */
export const WSOL_MINT = "So11111111111111111111111111111111111111112"

/** True when `mint` denotes native SOL (the literal "SOL" or the wrapped mint). */
export function isNativeSolOutput(mint?: string): boolean {
  if (!mint) return false
  return mint === "SOL" || mint === WSOL_MINT
}

/** True when `inputMint` denotes a non-SOL SPL token input. */
export function isTokenInputSwap(inputMint?: string): boolean {
  return Boolean(inputMint && !isNativeSolOutput(inputMint))
}

export type StrandAction = "skip" | "resume" | "landed" | "unresolved"

export interface ClassifyStrandArgs {
  hasSignature: boolean
  ageMs: number
  solLamports: bigint
  tokenAmount: bigint
  /** For token-input swaps: amount of input token currently sitting at the fresh address ATA */
  inputTokenAmount?: bigint
  /** Whether the swap input is a token (true) or native SOL (false) */
  isTokenInput?: boolean
}

/// Decide what to do with a stranded swap row from its on-chain footprint.
///  - skip:       already recorded, or still inside the in-flight grace window.
///  - resume:     the fresh address holds swappable funds → finish the swap leg.
///  - landed:     swapped funds are gone and bought token/SOL is present → record done.
///  - unresolved: nothing recoverable → leave for the user to dismiss manually.
export function classifyStrand(args: ClassifyStrandArgs): StrandAction {
  if (args.hasSignature) return "skip"
  if (args.ageMs < RESUME_GRACE_MS) return "skip"

  if (args.isTokenInput) {
    // If the input token is still sitting at the fresh address ATA, the swap
    // leg was never completed. It can be resumed as long as there is enough
    // leftover gas to pay the transaction fee.
    if (args.inputTokenAmount && args.inputTokenAmount > 0n) {
      return args.solLamports >= 5_000n ? "resume" : "unresolved"
    }
    // The input token has left the fresh address:
    // 1. For token output, presence of the bought token confirms completion.
    if (args.tokenAmount > 0n) return "landed"
    // 2. For native SOL output, leftover gas (<= 9,000,000 lamports) is NOT proof
    // of a landed swap (#855). Only balance exceeding the gas funding reserve
    // proves that realized swap output arrived.
    if (args.solLamports > GAS_LAMPORTS) return "landed"
    return "unresolved"
  }

  // Native SOL input swap:
  if (args.solLamports > RESUME_MIN_LAMPORTS) return "resume"
  if (args.tokenAmount > 0n) return "landed"
  return "unresolved"
}
