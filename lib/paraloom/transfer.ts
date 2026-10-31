// Shielded → shielded transfer (#197). Spends two notes the wallet owns and
// creates two outputs — one to the recipient, one change back to self — proving
// the TransferCircuit in the browser (#195) and encrypting each output to its
// recipient's shielded address (#196) so only they can discover and spend it.
// The spend secrets never leave the wallet.

import { Connection } from "@solana/web3.js"

import { addressBoxPubHex, addressSpendPubHex } from "~lib/crypto/keyManagement"
import { NATIVE_ASSET_HEX, noteCommitmentV2, proveTransferV2 } from "~lib/prover"

import { PATH_SERVER_URL, TRANSFER_INGRESS_URL } from "./constants"
import { encryptNote } from "./noteCrypto"
import {
  addDiscoveredNote,
  markNoteSpentByIdentity,
  type ShieldedNote
} from "./notes"
import { confirmCommitmentInTree } from "./settlementConfirm"
import { fetchV3Leaves } from "./transact"

interface MerklePathResponse {
  root: string
  path: string[]
  indices: boolean[]
}

export interface TransferResult {
  requestId: string
  changeCommitment: string
  settled?: boolean
}

const SETTLE_CONFIRM_TIMEOUT_MS = 60_000
const SETTLE_CONFIRM_POLL_MS = 1_500

export function confirmSettledByTree(
  connection: Connection,
  commitmentHex: string,
  timeoutMs = SETTLE_CONFIRM_TIMEOUT_MS,
  pollMs = SETTLE_CONFIRM_POLL_MS
): Promise<boolean> {
  return confirmCommitmentInTree(
    () => fetchV3Leaves(connection),
    commitmentHex,
    timeoutMs,
    pollMs
  )
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
  return (await res.json()) as MerklePathResponse
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
  spendPrivkeyHex: string,
  connection?: Connection,
  confirmSettled?: () => Promise<boolean>
): Promise<TransferResult> {
  const inputTotal = inputs.reduce((sum, n) => sum + BigInt(n.amount), 0n)
  if (inputTotal < amount) {
    throw new Error("Selected notes do not cover the transfer amount")
  }
  const change = inputTotal - amount

  // v2 (#293): an output binds the recipient's spend pubkey (so only they can
  // spend it) and is encrypted to their box pubkey (so only they can read it).
  const recipientSpendPub = addressSpendPubHex(recipientShieldedAddress)
  const recipientBoxPub = addressBoxPubHex(recipientShieldedAddress)
  const ownSpendPub = addressSpendPubHex(ownShieldedAddress)
  const ownBoxPub = addressBoxPubHex(ownShieldedAddress)

  // Pull each input's Merkle path. Both must prove against the same root.
  const paths: MerklePathResponse[] = []
  const proofInputs = []
  for (const note of inputs) {
    const commitment = await noteCommitmentV2(
      BigInt(note.amount),
      spendPrivkeyHex,
      note.blinding,
      note.assetId
    )
    const pathRes = await fetchPath(commitment)
    paths.push(pathRes)
    proofInputs.push({
      amount: Number(note.amount),
      blinding_hex: note.blinding,
      privkey_hex: spendPrivkeyHex,
      path_hex: pathRes.path,
      indices: pathRes.indices
    })
  }

  if (paths.length >= 2 && paths[0].root !== paths[1].root) {
    throw new Error("Merkle tree updated during witness assembly; retry to synchronize roots")
  }
  const root = paths[0]?.root ?? ""

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

  // Wait until the spend actually settles before touching local bookkeeping.
  // /transfer/submit only returns a queue ticket — the ingress accepts the request
  // before the proof is verified and the quorum settles it, so an HTTP 200 is not
  // a settlement. Marking inputs spent or adding change prematurely corrupts the
  // wallet balance if the transaction drops or fails (paraloom-core#792).
  const changeCommitment = output_commitments[1]
  const settleCommitmentHex = output_commitments[0]
  const settled = confirmSettled
    ? await confirmSettled()
    : connection
      ? await confirmSettledByTree(connection, settleCommitmentHex)
      : false

  if (settled) {
    for (const note of inputs) {
      await markNoteSpentByIdentity(account, note)
    }
    if (change > 0n) {
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
    }
  }

  return { requestId: request_id, changeCommitment, settled }
}
