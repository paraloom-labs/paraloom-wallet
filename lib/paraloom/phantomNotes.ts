// Phantom-note healing, shared by every spend path that selects input notes.
//
// Extracted from the background service worker (where it guarded only the
// native-SOL swap path) so the token-input swap path can run the exact same
// reconciliation, and so the logic is unit-testable without a chrome stub.
//
// Drop phantom notes before selection. A change/received note whose commitment
// is NOT in the on-chain tree never actually settled — a swap that timed out
// (before the node cosign fix) marked its inputs spent and recorded a change
// note whose leaf never landed, and a transfer whose settlement failed still
// delivered its output ciphertext to the recipient (the ingress serves the
// scan feed on arrival, before settlement). Selecting one bricks the whole
// spend at ensureLeafIndex ("note commitment not found in the on-chain tree").
// Deposit notes carry a trusted on-chain leafIndex and are never touched; only
// notes located by commitment (no leafIndex) and older than a settlement grace
// window are checked, so a just-settled note is never dropped on RPC lag.
// Dropping is a soft mark-spent (the record + blinding are kept), so nothing
// real is lost.

import type { Connection } from "@solana/web3.js"

import { markNoteSpentByCommitment, type ShieldedNote } from "./notes"
import { fetchV3Leaves } from "./transact"

// Matches the page-side swap/settlement timeout budget with headroom: a note
// younger than this may still be mid-settlement, not phantom.
export const PHANTOM_GRACE_MS = 120_000

export async function dropPhantomNotes(
  connection: Connection,
  account: string,
  notes: ShieldedNote[]
): Promise<ShieldedNote[]> {
  const GRACE_MS = PHANTOM_GRACE_MS
  const suspects = notes.filter(
    (n) =>
      n.leafIndex === undefined &&
      !!n.commitment &&
      Date.now() - n.createdAt > GRACE_MS
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
    console.log(
      `[paraloom] reconciled ${dropped.size} phantom note(s) not present on-chain`
    )
  }
  return notes.filter((n) => !(n.commitment && dropped.has(n.commitment)))
}
