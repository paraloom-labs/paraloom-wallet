import type { Connection } from "@solana/web3.js"
import { markNoteSpentByCommitment, type ShieldedNote } from "./notes"
import { fetchV3Leaves } from "./transact"

export const PHANTOM_GRACE_MS = 120_000

// Drop unspent notes whose leaf was never appended on-chain (#792, #857). Notes
// located by commitment (no leafIndex) and older than a settlement grace window
// are checked, so a just-settled note is never dropped on RPC lag. Dropping is a
// soft mark-spent (the record + blinding are kept), so nothing real is lost.
export async function dropPhantomNotes(
  connection: Connection,
  account: string,
  notes: ShieldedNote[],
  cachedLeaves?: { commitmentHex: string }[]
): Promise<ShieldedNote[]> {
  const suspects = notes.filter(
    (n) =>
      n.leafIndex === undefined &&
      !!n.commitment &&
      Date.now() - n.createdAt > PHANTOM_GRACE_MS
  )
  if (suspects.length === 0) return notes

  let onchain: Set<string>
  try {
    const leaves = cachedLeaves ?? (await fetchV3Leaves(connection))
    onchain = new Set(leaves.map((l) => l.commitmentHex))
  } catch {
    return notes // cannot rebuild the tree safely — drop nothing
  }

  const dropped = new Set<string>()
  for (const n of suspects) {
    if (n.commitment && !onchain.has(n.commitment)) {
      await markNoteSpentByCommitment(account, n.commitment)
      dropped.add(n.commitment)
    }
  }
  if (dropped.size > 0) {
    console.log(
      `[paraloom] reconciled ${dropped.size} phantom note(s) not present on-chain`
    )
  }
  return notes.filter((n) => !(n.commitment && dropped.has(n.commitment)))
}
