// Shielded → Solana withdrawal. Computes the note's commitment, fetches its
// Merkle path from a validator node, builds the Groth16 proof in the browser,
// and submits it to the validator ingress for BFT verification + on-chain
// settlement. The note secret never leaves the wallet.

import { NATIVE_ASSET_HEX, noteCommitmentV2, proveWithdrawalV2 } from "~lib/prover"

import { INGRESS_URL, PATH_SERVER_URL } from "./constants"
import { solanaAddressToBytes } from "./bridge"
import type { ShieldedNote } from "./notes"

const MERKLE_TREE_DEPTH = 32
const HEX32_RE = /^[0-9a-fA-F]{64}$/

interface MerklePathResponse {
  root: string
  path: string[]
  indices: boolean[]
}

export function validateMerklePathResponse(raw: unknown): MerklePathResponse {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid Merkle path response")
  }
  const { root, path, indices } = raw as Partial<MerklePathResponse>
  if (typeof root !== "string" || !HEX32_RE.test(root)) {
    throw new Error("Invalid Merkle root in path server response")
  }
  if (
    !Array.isArray(path) ||
    !Array.isArray(indices) ||
    path.length !== MERKLE_TREE_DEPTH ||
    indices.length !== MERKLE_TREE_DEPTH
  ) {
    throw new Error(`Merkle path must contain ${MERKLE_TREE_DEPTH} levels`)
  }
  if (!path.every((p) => typeof p === "string" && HEX32_RE.test(p))) {
    throw new Error("Invalid sibling hash in Merkle path")
  }
  if (!indices.every((b) => typeof b === "boolean")) {
    throw new Error("Invalid direction bit in Merkle path")
  }
  return { root, path, indices }
}

export interface WithdrawResult {
  requestId: string
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

// Withdraw a deposited note to a Solana address. `spendPrivkeyHex` is the
// account's circuit-v2 spend key. Throws with a readable message if the note is
// not yet indexed or the node is unreachable.
export async function withdraw(
  note: ShieldedNote,
  toSolanaAddress: string,
  spendPrivkeyHex: string
): Promise<WithdrawResult> {
  if (note.spent) {
    throw new Error("Cannot withdraw an already-spent note")
  }
  const amount = BigInt(note.amount)
  if (amount <= 0n) {
    throw new Error("Withdrawal amount must be greater than 0")
  }
  const assetId = note.assetId || NATIVE_ASSET_HEX

  const commitment = await noteCommitmentV2(amount, spendPrivkeyHex, note.blinding, assetId)

  const pathRes = await fetch(`${PATH_SERVER_URL}/merkle/path/${commitment}`)
  if (pathRes.status === 404) {
    throw new Error("Note not indexed by the validators yet — try again shortly")
  }
  if (!pathRes.ok) {
    throw new Error(`Path server error (${pathRes.status})`)
  }
  const { root, path, indices } = validateMerklePathResponse(await pathRes.json())

  // The on-chain program binds the proof to this destination via
  // ext_data_hash = sha256(recipient || amount); the body's recipient must
  // match exactly, so the payout cannot be redirected (#293 finding D).
  const destRecipientHex = toHex(solanaAddressToBytes(toSolanaAddress.trim()))

  const { nullifier, proof } = await proveWithdrawalV2({
    root,
    amount,
    blinding: note.blinding,
    privkey: spendPrivkeyHex,
    assetId,
    destRecipient: destRecipientHex,
    path,
    indices
  })

  const body = {
    nullifier,
    recipient: destRecipientHex,
    proof,
    amount: Number(amount),
    fee: 0
  }

  const res = await fetch(`${INGRESS_URL}/withdrawal/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    throw new Error(`Ingress rejected the withdrawal (${res.status})`)
  }
  const { request_id } = (await res.json()) as { request_id: string }
  return { requestId: request_id }
}
