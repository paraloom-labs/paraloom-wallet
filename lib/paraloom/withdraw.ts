// Shielded → Solana withdrawal. Computes the note's commitment, fetches its
// Merkle path from a validator node, builds the Groth16 proof in the browser,
// and submits it to the validator ingress for BFT verification + on-chain
// settlement. The note secret never leaves the wallet.

import { noteCommitmentV2, proveWithdrawalV2, NATIVE_ASSET_HEX } from "~lib/prover"

import { INGRESS_URL, PATH_SERVER_URL } from "./constants"
import { solanaAddressToBytes } from "./bridge"
import type { ShieldedNote } from "./notes"

export interface MerklePathResponse {
  root: string
  path: string[]
  indices: boolean[]
}

export interface WithdrawResult {
  requestId: string
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

export function validateMerklePathResponse(data: unknown): MerklePathResponse {
  if (!data || typeof data !== "object") {
    throw new Error("invalid Merkle path response: expected object")
  }
  const { root, path, indices } = data as Partial<MerklePathResponse>
  if (typeof root !== "string" || !/^[0-9a-fA-F]{64}$/.test(root)) {
    throw new Error("invalid Merkle path response: root must be a 64-hex string")
  }
  if (
    !Array.isArray(path) ||
    path.length !== 32 ||
    !path.every((p) => typeof p === "string" && /^[0-9a-fA-F]{64}$/.test(p))
  ) {
    throw new Error("invalid Merkle path response: path must be 32 64-hex strings")
  }
  if (
    !Array.isArray(indices) ||
    indices.length !== 32 ||
    !indices.every((i) => typeof i === "boolean")
  ) {
    throw new Error("invalid Merkle path response: indices must be 32 booleans")
  }
  return { root, path, indices }
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
    throw new Error("cannot withdraw already spent note")
  }
  let amount: bigint
  try {
    amount = BigInt(note.amount)
  } catch {
    throw new Error(`invalid note amount: ${note.amount}`)
  }
  if (amount <= 0n) {
    throw new Error("withdraw amount must be positive")
  }

  const assetId = note.assetId || NATIVE_ASSET_HEX
  if (assetId !== NATIVE_ASSET_HEX) {
    throw new Error("v2 withdrawal only supports native SOL notes")
  }

  const trimmedAddress = typeof toSolanaAddress === "string" ? toSolanaAddress.trim() : ""
  if (!trimmedAddress) {
    throw new Error("invalid recipient address")
  }
  const destRecipientHex = toHex(solanaAddressToBytes(trimmedAddress))

  const commitment = await noteCommitmentV2(amount, spendPrivkeyHex, note.blinding, assetId)

  const pathRes = await fetch(`${PATH_SERVER_URL}/merkle/path/${commitment}`)
  if (pathRes.status === 404) {
    throw new Error("Note not indexed by the validators yet — try again shortly")
  }
  if (!pathRes.ok) {
    throw new Error(`Path server error (${pathRes.status})`)
  }
  const rawPath = await pathRes.json()
  const { root, path, indices } = validateMerklePathResponse(rawPath)

  // The on-chain program binds the proof to this destination via
  // ext_data_hash = sha256(recipient || amount); the body's recipient must
  // match exactly, so the payout cannot be redirected (#293 finding D).
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
