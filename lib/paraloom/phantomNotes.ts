import type { Connection } from "@solana/web3.js"
import { markNoteSpentByCommitment, type ShieldedNote } from "./notes"
import { fetchV3Leaves } from "./transact"

// Settlement grace: a note created moments ago whose leaf may still be in
// flight on RPC lag is never checked, let alone dropped.
export const PHANTOM_GRACE_MS = 120_000

// Drop phantom notes before selection. A change/received note whose commitment
// is NOT in the on-chain tree never actually settled — a swap that timed out
// (before the node cosign fix) marked its inputs spent and recorded a change
// note whose leaf never landed. Selecting one bricks the whole spend at
// ensureLeafIndex ("note commitment not found in the on-chain tree"). Deposit
// notes carry a trusted on-chain leafIndex and are never touched; only notes
// located by commitment (no leafIndex) and older than a settlement grace window
// are checked, so a just-settled note is never dropped on RPC lag. Dropping is a
// soft mark-spent (the record + blinding are kept), so nothing real is lost.
export async function dropPhantomNotes(
  connection: Connection,
  account: string,
  notes: ShieldedNote[]
): Promise<ShieldedNote[]> {
  const suspects = notes.filter(
    (n) =>
      n.leafIndex === undefined && !!n.commitment && Date.now() - n.createdAt > PHANTOM_GRACE_MS
  )
  if (suspects.length === 0) return notes

  let onchain: Set<string>
  try {
    const leaves = await fetchV3Leaves(connection)
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
    console.log(`[paraloom] reconciled ${dropped.size} phantom note(s) not present on-chain`)
  }
  return notes.filter((n) => !(n.commitment && dropped.has(n.commitment)))
}
