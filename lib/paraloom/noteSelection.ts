// Which notes a spend may take (#195). Pure, so it is unit-testable without the
// prover/wasm the popup pulls in. The list it works on mixes native SOL notes
// with shielded SPL notes, whose `amount` is in the token's own base units
// (1_000_000_000 raw USDC = "1000 USDC" out-sorts 0.8 SOL = 800_000_000
// lamports), so every native selection has to filter to native notes first.

import { NATIVE_ASSET_HEX } from "~lib/prover"
import type { ShieldedNote } from "./notes"

// Below this a native note on its own costs more to withdraw (25 bps fee + tx
// fee) than it is worth: it is dust. Still counted in the shielded total, and
// still usable as the SECOND input of a 2-note spend.
export const WITHDRAW_DUST_LAMPORTS = 1_000_000n // 0.001 SOL

// Native (non-token) note: no assetId at all, or the all-zero native asset.
// Same test shieldedBalance() applies.
export function isNativeNote(n: ShieldedNote): boolean {
  return !n.assetId || n.assetId === NATIVE_ASSET_HEX
}

// Exact descending order. The difference stays a BigInt; only its SIGN is
// narrowed to the Number a comparator must return, so the magnitude (which is
// what loses precision above Number.MAX_SAFE_INTEGER) is never converted.
export function byAmountDesc(a: ShieldedNote, b: ShieldedNote): number {
  const d = BigInt(b.amount) - BigInt(a.amount)
  return d > 0n ? 1 : d < 0n ? -1 : 0
}

// Unspent native notes, largest first.
export function unspentNativeNotes(all: ShieldedNote[]): ShieldedNote[] {
  return all.filter((n) => !n.spent && isNativeNote(n)).sort(byAmountDesc)
}

// Unspent native notes not below the dust threshold, largest first.
export function spendableSolNotes(all: ShieldedNote[]): ShieldedNote[] {
  return unspentNativeNotes(all).filter((n) => BigInt(n.amount) >= WITHDRAW_DUST_LAMPORTS)
}

// Pick up to 2 unspent native notes covering `lamports` for a shielded transfer.
// Null if they can't cover it. A transfer pays no SOL fee out of the note, so
// dust notes are eligible inputs here too.
export function selectTransferInputs(all: ShieldedNote[], lamports: bigint): ShieldedNote[] | null {
  const chosen: ShieldedNote[] = []
  let sum = 0n
  for (const n of unspentNativeNotes(all)) {
    if (sum >= lamports || chosen.length === 2) break
    chosen.push(n)
    sum += BigInt(n.amount)
  }
  return sum >= lamports ? chosen : null
}

// A selection is only worth proving if the notes it spends are worth spending:
// at least one of them has to clear the dust threshold on its own, which lets an
// all-dust pair through once their SUM clears it.
function isWorthWithdrawing(notes: ShieldedNote[]): boolean {
  if (notes.some((n) => BigInt(n.amount) >= WITHDRAW_DUST_LAMPORTS)) return true
  return notes.reduce((s, n) => s + BigInt(n.amount), 0n) >= WITHDRAW_DUST_LAMPORTS
}

// Pick up to 2 native notes covering `lamports` for a withdrawal (a transact
// spends 1–2 and returns change). Null if they can't cover it.
export function selectSolWithdrawNotes(
  all: ShieldedNote[],
  lamports: bigint
): ShieldedNote[] | null {
  const [primary, second] = unspentNativeNotes(all)
  if (!primary) return null
  const primaryAmount = BigInt(primary.amount)
  // A lone note has to be worth the withdraw on its own (25 bps fee + tx fee),
  // so one below the dust threshold stays excluded — exactly as before.
  if (primaryAmount >= WITHDRAW_DUST_LAMPORTS && primaryAmount >= lamports) {
    return [primary]
  }
  // The circuit pads a one-note spend with a zero dummy input anyway, so a
  // sub-dust note costs nothing extra as the SECOND input — taking it here is
  // what stops dust notes being stranded while shieldedBalance() still counts
  // them. Largest remaining native note, so if it can't close the gap no
  // smaller one can.
  if (!second) return null
  const chosen = [primary, second]
  const sum = primaryAmount + BigInt(second.amount)
  if (sum < lamports) return null
  return isWorthWithdrawing(chosen) ? chosen : null
}

// Most a single withdrawal can take: the two largest native notes, provided that
// pair is one the selector can actually choose.
export function maxSolWithdrawLamports(all: ShieldedNote[]): bigint {
  const chosen = unspentNativeNotes(all).slice(0, 2)
  if (!isWorthWithdrawing(chosen)) return 0n
  return chosen.reduce((s, n) => s + BigInt(n.amount), 0n)
}

// The one asset all of a spend's inputs share. `expectedAssetIdHex` is the guard
// for a caller that knows what it means to spend (a native SOL transfer): without
// it a lone SPL note in the input list silently makes spendV3 infer `isSpl` and
// send tokens instead of SOL (#195).
export function resolveSpendAsset(inputs: ShieldedNote[], expectedAssetIdHex?: string): string {
  const assetIdHex = inputs[0].assetId || NATIVE_ASSET_HEX
  if (inputs.some((n) => (n.assetId || NATIVE_ASSET_HEX) !== assetIdHex)) {
    throw new Error("all spent notes must share one asset")
  }
  if (expectedAssetIdHex !== undefined && assetIdHex !== expectedAssetIdHex) {
    throw new Error("selected notes do not match the expected asset")
  }
  return assetIdHex
}
