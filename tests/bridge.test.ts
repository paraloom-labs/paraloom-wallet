import { sha256 } from "@noble/hashes/sha256"
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js"
import { buildDepositInstruction } from "~lib/paraloom/bridge"
import {
  BRIDGE_STATE_SEED,
  BRIDGE_VAULT_SEED,
  DEPOSIT_DISCRIMINATOR,
  DEPOSIT_NOTE_DISCRIMINATOR,
  MERKLE_TREE_SEED,
  PROGRAM_ID
} from "~lib/paraloom/constants"
import { depositNoteInstruction } from "~lib/paraloom/transact"
import { describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({ NATIVE_ASSET_HEX: "00".repeat(32) }))

describe("buildDepositInstruction", () => {
  const programId = new PublicKey(PROGRAM_ID)
  const depositor = Keypair.generate().publicKey
  const recipient = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
  const randomness = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i)

  it("includes merkle_tree PDA at account index 2 and matches on-chain DepositNote account metas", () => {
    const ix = buildDepositInstruction(depositor, 1_500_000_000n, recipient, randomness)

    const [expectedBridgeState] = PublicKey.findProgramAddressSync(
      [Buffer.from(BRIDGE_STATE_SEED)],
      programId
    )
    const [expectedBridgeVault] = PublicKey.findProgramAddressSync(
      [Buffer.from(BRIDGE_VAULT_SEED)],
      programId
    )
    const [expectedMerkleTree] = PublicKey.findProgramAddressSync(
      [Buffer.from(MERKLE_TREE_SEED)],
      programId
    )

    expect(ix.programId.toBase58()).toBe(PROGRAM_ID)
    expect(ix.keys).toHaveLength(5)
    expect(
      ix.keys.map((k) => ({
        pubkey: k.pubkey.toBase58(),
        isSigner: k.isSigner,
        isWritable: k.isWritable
      }))
    ).toEqual([
      { pubkey: expectedBridgeState.toBase58(), isSigner: false, isWritable: true },
      { pubkey: expectedBridgeVault.toBase58(), isSigner: false, isWritable: true },
      { pubkey: expectedMerkleTree.toBase58(), isSigner: false, isWritable: true },
      { pubkey: depositor.toBase58(), isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId.toBase58(), isSigner: false, isWritable: false }
    ])
  })

  it("encodes DEPOSIT_NOTE_DISCRIMINATOR, u64 LE amount, recipient, and randomness", () => {
    const amount = 5_123_456_789n // exceeds 2^32 to exercise full u64 LE encoding
    const ix = buildDepositInstruction(depositor, amount, recipient, randomness)

    expect(ix.data.byteLength).toBe(80)

    const expectedDisc = sha256("global:deposit_note").slice(0, 8)
    expect(Uint8Array.from(ix.data.subarray(0, 8))).toEqual(expectedDisc)
    expect(Uint8Array.from(ix.data.subarray(0, 8))).toEqual(DEPOSIT_NOTE_DISCRIMINATOR)
    expect(Uint8Array.from(ix.data.subarray(0, 8))).not.toEqual(DEPOSIT_DISCRIMINATOR)

    const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength)
    expect(view.getBigUint64(8, true)).toBe(amount)
    expect(Uint8Array.from(ix.data.subarray(16, 48))).toEqual(recipient)
    expect(Uint8Array.from(ix.data.subarray(48, 80))).toEqual(randomness)
  })

  it("produces wire-identical output to depositNoteInstruction in transact.ts", () => {
    const amount = 250_000_000n
    const fromBridge = buildDepositInstruction(depositor, amount, recipient, randomness)
    const fromTransact = depositNoteInstruction(depositor, amount, recipient, randomness)

    expect(fromBridge.programId.equals(fromTransact.programId)).toBe(true)
    expect(fromBridge.keys).toEqual(fromTransact.keys)
    expect(Buffer.compare(fromBridge.data, fromTransact.data)).toBe(0)
  })
})
