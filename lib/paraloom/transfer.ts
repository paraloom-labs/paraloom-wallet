// Shielded → shielded transfer (#197). Spends two notes the wallet owns and
// creates two outputs — one to the recipient, one change back to self — proving
// the TransferCircuit in the browser (#195) and encrypting each output to its
// recipient's shielded address (#196) so only they can discover and spend it.
// The spend secrets never leave the wallet.

import { addressBoxPubHex, addressSpendPubHex } from "~lib/crypto/keyManagement"
import { NATIVE_ASSET_HEX, noteCommitmentV2, proveTransferV2 } from "~lib/prover"

import { PATH_SERVER_URL, TRANSFER_INGRESS_URL } from "./constants"
import { encryptNote } from "./noteCrypto"
import {
  addDiscoveredNote,
  markNoteSpent,
  markNoteSpentByCommitment,
  type ShieldedNote
} from "./notes"
import { validateMerklePathResponse, type MerklePathResponse } from "./withdraw"

export interface TransferResult {
  requestId: string
  changeCommitment: string
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function randomHex32(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)))
}

async function fetchPath(commitment: string): Promise<MerklePathResponse> {
  const res = await fetch(`${PATH_SERVER_URL}/merkle/path/${commitment}`)
  if (res.status === 404) {
    throw new Error("An input note is not indexed by the validators yet — try again shortly")
  }
  if (!res.ok) {
    throw new Error(`Path server error (${res.status})`)
  }
  const rawPath = await res.json()
  return validateMerklePathResponse(rawPath)
}

// Send `amount` lamports from two owned input notes to `recipientShieldedAddress`,
// with the remainder as change back to this wallet. `inputs` must be exactly two
// unspent notes the wallet owns whose values sum to at least `amount` (the
// circuit is fixed 2-in/2-out and every input must be a real tree member).
export async function transfer(
  account: string,
  ownShieldedAddress: string,
  recipientShieldedAddress: string,
  amount: bigint,
  inputs: [ShieldedNote, ShieldedNote],
  spendPrivkeyHex: string
): Promise<TransferResult> {
  if (typeof amount !== "bigint" || amount <= 0n) {
    throw new Error("transfer amount must be positive")
  }
  if (!Array.isArray(inputs) || inputs.length !== 2) {
    throw new Error("Transfer requires exactly two input notes")
  }

  const [n0, n1] = inputs
  if (
    (n0.blinding && n1.blinding && n0.blinding.toLowerCase() === n1.blinding.toLowerCase()) ||
    (n0.commitment && n1.commitment && n0.commitment.toLowerCase() === n1.commitment.toLowerCase())
  ) {
    throw new Error("cannot use duplicate input notes in transfer")
  }

  for (const note of inputs) {
    if (note.spent) {
      throw new Error("cannot transfer already spent note")
    }
    let noteAmount: bigint
    try {
      noteAmount = BigInt(note.amount)
    } catch {
      throw new Error(`invalid note amount: ${note.amount}`)
    }
    if (noteAmount <= 0n) {
      throw new Error("input note amount must be positive")
    }
    const assetId = note.assetId || NATIVE_ASSET_HEX
    if (assetId !== NATIVE_ASSET_HEX) {
      throw new Error("v2 transfer only supports native SOL notes")
    }
  }

  const inputTotal = inputs.reduce((sum, n) => sum + BigInt(n.amount), 0n)
  if (inputTotal < amount) {
    throw new Error("Selected notes do not cover the transfer amount")
  }
  const change = inputTotal - amount

  // v2 (#293): an output binds the recipient's spend pubkey (so only they can
  // spend it) and is encrypted to their box pubkey (so only they can read it).
  const trimmedRecipient = typeof recipientShieldedAddress === "string" ? recipientShieldedAddress.trim() : ""
  const trimmedOwn = typeof ownShieldedAddress === "string" ? ownShieldedAddress.trim() : ""
  const recipientSpendPub = addressSpendPubHex(trimmedRecipient)
  const recipientBoxPub = addressBoxPubHex(trimmedRecipient)
  const ownSpendPub = addressSpendPubHex(trimmedOwn)
  const ownBoxPub = addressBoxPubHex(trimmedOwn)

  // Pull each input's Merkle path. Both must prove against the same root; the
  // tree is stable between these two quick reads on devnet, so use the latest.
  let root = ""
  const proofInputs = []
  for (const note of inputs) {
    const assetId = note.assetId || NATIVE_ASSET_HEX
    const commitment = await noteCommitmentV2(
      BigInt(note.amount),
      spendPrivkeyHex,
      note.blinding,
      assetId
    )
    const pathRes = await fetchPath(commitment)
    root = pathRes.root
    proofInputs.push({
      amount: Number(note.amount),
      blinding_hex: note.blinding,
      privkey_hex: spendPrivkeyHex,
      path_hex: pathRes.path,
      indices: pathRes.indices
    })
  }

  // Output 0 → recipient, output 1 → change back to self. Fresh blinding each.
  const outBlind0 = randomHex32()
  const outBlind1 = randomHex32()
  const outputs = [
    { amount: Number(amount), blinding_hex: outBlind0, pubkey_hex: recipientSpendPub },
    { amount: Number(change), blinding_hex: outBlind1, pubkey_hex: ownSpendPub }
  ]

  const { nullifiers, output_commitments, proof } = await proveTransferV2(
    root,
    NATIVE_ASSET_HEX,
    proofInputs,
    outputs
  )

  // Encrypt each output note to its recipient's box pubkey so they can discover
  // and spend it (they recompute the commitment with their own spend key).
  const ciphertexts = [
    encryptNote(recipientBoxPub, {
      amount,
      blindingHex: outBlind0,
      assetIdHex: NATIVE_ASSET_HEX
    }),
    encryptNote(ownBoxPub, { amount: change, blindingHex: outBlind1, assetIdHex: NATIVE_ASSET_HEX })
  ]

  const body = {
    nullifiers,
    output_commitments,
    // The node recomputes the authoritative post-state root from its own pool;
    // we send the current root (advisory). L2 verification uses the pool root.
    new_merkle_root: root,
    proof,
    ciphertexts
  }

  const res = await fetch(`${TRANSFER_INGRESS_URL}/transfer/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    throw new Error(`Transfer ingress rejected the transfer (${res.status})`)
  }
  const { request_id } = (await res.json()) as { request_id: string }

  // Mark the spent inputs and store the change note locally (the recipient
  // discovers their output by scanning). A deposit note is identified by its
  // signature, a discovered transfer note by its commitment.
  for (const note of inputs) {
    if (note.signature) {
      await markNoteSpent(account, note.signature)
    }
    if (note.commitment) {
      await markNoteSpentByCommitment(account, note.commitment)
    }
  }
  const changeCommitment = output_commitments[1]
  await addDiscoveredNote(account, {
    amount: change.toString(),
    blinding: outBlind1,
    assetId: NATIVE_ASSET_HEX,
    signature: "",
    createdAt: Date.now(),
    spent: false,
    commitment: changeCommitment,
    source: "transfer"
  })

  return { requestId: request_id, changeCommitment }
}
