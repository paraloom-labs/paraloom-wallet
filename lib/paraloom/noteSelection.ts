import { NATIVE_ASSET_HEX } from "./constants"
import type { ShieldedNote } from "./notes"

// Below this a native note costs more to withdraw (25 bps fee + tx fee) than it
// is worth: it is dust. Hidden from single-note withdraw selection so the picker
// isn't buried under worthless fillers, but allowed as the second input note
// when paired with a primary note >= WITHDRAW_DUST_LAMPORTS (or when the combined
// total is >= WITHDRAW_DUST_LAMPORTS), preventing sub-0.001 SOL change notes
// from becoming permanently stranded (#195).
export const WITHDRAW_DUST_LAMPORTS = 1_000_000n // 0.001 SOL

// Unspent native (non-token) notes worth withdrawing individually, largest first.
export function spendableSolNotes(all: ShieldedNote[]): ShieldedNote[] {
  return all
    .filter(
      (n) =>
        !n.spent &&
        (!n.assetId || n.assetId === NATIVE_ASSET_HEX) &&
        BigInt(n.amount) >= WITHDRAW_DUST_LAMPORTS
    )
    .sort((a, b) => {
      const d = BigInt(b.amount) - BigInt(a.amount)
      return d > 0n ? 1 : d < 0n ? -1 : 0
    })
}

// Maximum native SOL lamports withdrawable in a single 2-note transact.
export function maxSolWithdrawLamports(all: ShieldedNote[]): bigint {
  const unspent = all
    .filter((n) => !n.spent && (!n.assetId || n.assetId === NATIVE_ASSET_HEX))
    .sort((a, b) => {
      const d = BigInt(b.amount) - BigInt(a.amount)
      return d > 0n ? 1 : d < 0n ? -1 : 0
    })
  const top2 = unspent.slice(0, 2)
  const sum = top2.reduce((s, n) => s + BigInt(n.amount), 0n)
  return sum >= WITHDRAW_DUST_LAMPORTS ? sum : 0n
}

// Pick up to 2 spendable notes covering `lamports` (a transact spends 1–2 and
// returns change). Null if 2 notes can't cover it.
// Allows sub-WITHDRAW_DUST_LAMPORTS change notes as the second input note when
// paired with a primary note >= WITHDRAW_DUST_LAMPORTS (or when the combined
// total is >= WITHDRAW_DUST_LAMPORTS), preventing sub-0.001 SOL change notes
// from becoming stranded (#195).
export function selectSolWithdrawNotes(
  all: ShieldedNote[],
  lamports: bigint
): ShieldedNote[] | null {
  if (lamports <= 0n) return null
  const unspent = all
    .filter((n) => !n.spent && (!n.assetId || n.assetId === NATIVE_ASSET_HEX))
    .sort((a, b) => {
      const d = BigInt(b.amount) - BigInt(a.amount)
      return d > 0n ? 1 : d < 0n ? -1 : 0
    })

  if (unspent.length === 0) return null

  // 1. Single note: can any single note >= WITHDRAW_DUST_LAMPORTS cover `lamports`?
  // We prefer the smallest single note >= WITHDRAW_DUST_LAMPORTS covering `lamports`.
  const singleCandidate = [...unspent]
    .reverse()
    .find((n) => BigInt(n.amount) >= lamports && BigInt(n.amount) >= WITHDRAW_DUST_LAMPORTS)
  if (singleCandidate) {
    return [singleCandidate]
  }

  // 2. Pair 2 notes: start with the largest note as primary.
  const primary = unspent[0]
  const primaryAmt = BigInt(primary.amount)

  // Find a second note such that:
  // (primaryAmt + secondaryAmt >= lamports) AND (primaryAmt + secondaryAmt >= WITHDRAW_DUST_LAMPORTS).
  // Searching smallest to largest among candidates picks the best fit (e.g. sweeps dust change).
  const secondCandidates = unspent.slice(1).filter((n) => {
    const total = primaryAmt + BigInt(n.amount)
    return total >= lamports && total >= WITHDRAW_DUST_LAMPORTS
  })

  if (secondCandidates.length > 0) {
    const secondary = secondCandidates[secondCandidates.length - 1]
    return [primary, secondary]
  }

  return null
}
