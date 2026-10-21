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

/** Protocol withdrawal fee taken on-chain by `transact` before crediting the
 *  fresh address, in basis points. */
export const WITHDRAWAL_FEE_BPS = 25n

/** Lamports left at the fresh address to pay the re-shield deposit tx.
 *  Mirrors RESHIELD_FEE_RESERVE in privateSwap. */
export const RESHIELD_FEE_RESERVE_LAMPORTS = 1_000_000n

/** Smallest shielded-SOL withdraw that still leaves a swappable balance once
 *  the protocol withdrawal fee AND the swap overhead reserve are taken:
 *    amount - (amount * 25 / 10_000) > RESUME_MIN_LAMPORTS  =>  amount >= 6_015_038
 *  Anything below this can never fund the swap leg, so `privateSwap` must reject
 *  it BEFORE `spendV3` — otherwise the withdraw settles on-chain, burning the
 *  note and the fee, and the swap throws with nothing to show for it. */
export const MIN_SOL_SWAP_WITHDRAW_LAMPORTS = 6_015_038n

/** Lamports actually credited to the fresh address for a requested withdraw,
 *  i.e. net of the on-chain protocol withdrawal fee. */
export function expectedNetWithdrawLamports(amountLamports: bigint): bigint {
  if (amountLamports <= 0n) return 0n
  return amountLamports - (amountLamports * WITHDRAWAL_FEE_BPS) / 10_000n
}

/** True when a stranded fresh address holds SOL that is above the re-shield fee
 *  reserve (so a sweep can pay for itself) but at or below the swap overhead
 *  reserve (so the swap leg can never run). Such lamports are recoverable by
 *  sweeping them straight back into the shielded pool — they must NOT be left
 *  in "unresolved", where Dismiss deletes the fresh key and burns them. */
export function isSubReserveRecoverableSol(solLamports: bigint): boolean {
  return (
    solLamports > RESHIELD_FEE_RESERVE_LAMPORTS &&
    solLamports <= RESUME_MIN_LAMPORTS
  )
}

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

export type StrandAction = "skip" | "resume" | "landed" | "unresolved"

/// Decide what to do with a stranded swap row from its on-chain footprint.
///  - skip:       already recorded, or still inside the in-flight grace window.
///  - resume:     the fresh address holds SOL worth recovering → finish the swap
///                (or, when the balance is too small to ever fund the swap leg,
///                sweep it straight back into the shielded pool).
///  - landed:     SOL is gone but the bought token sits there → record it done.
///  - unresolved: nothing recoverable → leave for the user to dismiss manually.
export function classifyStrand(args: {
  hasSignature: boolean
  ageMs: number
  solLamports: bigint
  tokenAmount: bigint
}): StrandAction {
  if (args.hasSignature) return "skip"
  if (args.ageMs < RESUME_GRACE_MS) return "skip"
  if (args.solLamports > RESUME_MIN_LAMPORTS) return "resume"
  if (args.tokenAmount > 0n) return "landed"
  // Sub-reserve SOL: too little to ever fund the swap leg, but above the
  // re-shield fee reserve — real, sweepable lamports. Recover them instead of
  // reporting "unresolved", where Dismiss deletes the fresh key and burns them.
  if (isSubReserveRecoverableSol(args.solLamports)) return "resume"
  return "unresolved"
}
