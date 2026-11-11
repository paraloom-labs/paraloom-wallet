import { addressBoxPubHex, addressSpendPubHex } from "~lib/crypto/keyManagement"
import { NATIVE_ASSET_HEX, noteCommitmentV2, proveTransferV2 } from "~lib/prover"
import { PATH_SERVER_URL, TRANSFER_INGRESS_URL } from "~lib/paraloom/constants"
import { encryptNote } from "~lib/paraloom/noteCrypto"
import { addDiscoveredNote, markNoteSpent, markNoteSpentByCommitment, type ShieldedNote } from "~lib/paraloom/notes"
import { confirmCommitmentInTree } from "~lib/paraloom/settlementConfirm"
import { fetchV3Leaves } from "~lib/paraloom/transact"

interface MerklePathResponse {
  root: string
  path: string[]
  indices: boolean[]
}

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
  return (await res.json()) as MerklePathResponse
}

export async function transfer(
  account: string,
  ownShieldedAddress: string,
  recipientShieldedAddress: string,
  amount: bigint,
  inputs: [ShieldedNote, ShieldedNote],
  spendPrivkeyHex: string
): Promise<TransferResult> {
  const inputTotal = inputs.reduce((sum, n) => sum + BigInt(n.amount), 0n)
  if (inputTotal < amount) {
    throw new Error("Selected notes do not cover the transfer amount")
  }
  const change = inputTotal - amount

  const recipientSpendPub = addressSpendPubHex(recipientShieldedAddress)
  const recipientBoxPub = addressBoxPubHex(recipientShieldedAddress)
  const ownSpendPub = addressSpendPubHex(ownShieldedAddress)
  const ownBoxPub = addressBoxPubHex(ownShieldedAddress)

  const commitments = await Promise.all(inputs.map(n => noteCommitmentV2(BigInt(n.amount), spendPrivkeyHex, n.blinding, n.assetId)))
  const paths = await Promise.all(commitments.map(fetchPath))
  
  const root = paths[0].root
  if (paths.some(p => p.root !== root)) {
    throw new Error("Merkle root mismatch across inputs")
  }

  const proofInputs = inputs.map((note, i) => ({
    amount: Number(note.amount),
    blinding_hex: note.blinding,
    privkey_hex: spendPrivkeyHex,
    path_hex: paths[i].path,
    indices: paths[i].indices
  }))

  const outBlind0 = randomHex32()
  const outBlind1 = randomHex32()
  const outputs = [
    { amount: Number(amount), blinding_hex: outBlind0, pubkey_hex: recipientSpendPub },
    { amount: Number(change), blinding_hex: outBlind1, pubkey_hex: ownSpendPub }
  ]

  const { nullifiers, output_commitments, proof } = await proveTransferV2(root, NATIVE_ASSET_HEX, proofInputs, outputs)

  const ciphertexts = [
    encryptNote(recipientBoxPub, { amount, blindingHex: outBlind0, assetIdHex: NATIVE_ASSET_HEX }),
    encryptNote(ownBoxPub, { amount: change, blindingHex: outBlind1, assetIdHex: NATIVE_ASSET_HEX })
  ]

  const res = await fetch(`${TRANSFER_INGRESS_URL}/transfer/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nullifiers, output_commitments, new_merkle_root: root, proof, ciphertexts })
  })
  if (!res.ok) throw new Error(`Transfer ingress rejected the transfer (${res.status})`)
  const { request_id } = (await res.json()) as { request_id: string }

  const settled = await confirmCommitmentInTree(() => fetchV3Leaves(null as any), output_commitments[1], 150_000, 6_000)
  if (!settled) throw new Error("Transfer failed to settle on-chain")

  for (const note of inputs) {
    if (note.signature) await markNoteSpent(account, note.signature)
    if (note.commitment) await markNoteSpentByCommitment(account, note.commitment)
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