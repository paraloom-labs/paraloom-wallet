import { sha256 } from "@noble/hashes/sha256"
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js"
import { describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32)
}))

import { buildDepositInstruction } from "~lib/paraloom/bridge"
import {
  BRIDGE_STATE_SEED,
  BRIDGE_VAULT_SEED,
  DEPOSIT_NOTE_DISCRIMINATOR,
  MERKLE_TREE_SEED,
  PROGRAM_ID
} from "~lib/paraloom/constants"

describe("buildDepositInstruction (#133)", () => {
  it("includes merkle_tree PDA account and uses DEPOSIT_NOTE_DISCRIMINATOR", () => {
    const programId = new PublicKey(PROGRAM_ID)
    const depositor = Keypair.generate().publicKey
    const amountLamports = 1_000_000_000n
    const recipient = new Uint8Array(32).fill(1)
    const randomness = new Uint8Array(32).fill(2)

    const ix = buildDepositInstruction(depositor, amountLamports, recipient, randomness)

    expect(ix.programId.toBase58()).toBe(PROGRAM_ID)

    // Must have exactly 5 accounts matching Anchor DepositNote struct
    expect(ix.keys).toHaveLength(5)

    const expectedBridgeState = PublicKey.findProgramAddressSync(
      [Buffer.from(BRIDGE_STATE_SEED)],
      programId
    )[0]
    const expectedBridgeVault = PublicKey.findProgramAddressSync(
      [Buffer.from(BRIDGE_VAULT_SEED)],
      programId
    )[0]
    const expectedMerkleTree = PublicKey.findProgramAddressSync(
      [Buffer.from(MERKLE_TREE_SEED)],
      programId
    )[0]

    expect(ix.keys[0]).toEqual({
      pubkey: expectedBridgeState,
      isSigner: false,
      isWritable: true
    })
    expect(ix.keys[1]).toEqual({
      pubkey: expectedBridgeVault,
      isSigner: false,
      isWritable: true
    })
    expect(ix.keys[2]).toEqual({
      pubkey: expectedMerkleTree,
      isSigner: false,
      isWritable: true
    })
    expect(ix.keys[3]).toEqual({
      pubkey: depositor,
      isSigner: true,
      isWritable: true
    })
    expect(ix.keys[4]).toEqual({
      pubkey: SystemProgram.programId,
      isSigner: false,
      isWritable: false
    })

    // Validate instruction data payload layout: discriminator (8) | amount u64 (8) | recipient (32) | randomness (32)
    expect(ix.data.length).toBe(8 + 8 + 32 + 32)

    const expectedDiscriminator = sha256(new TextEncoder().encode("global:deposit_note")).slice(
      0,
      8
    )
    const disc = ix.data.subarray(0, 8)
    expect(Uint8Array.from(disc)).toEqual(DEPOSIT_NOTE_DISCRIMINATOR)
    expect(Array.from(disc)).toEqual(Array.from(expectedDiscriminator))

    const amountRead = new DataView(
      ix.data.buffer,
      ix.data.byteOffset,
      ix.data.byteLength
    ).getBigUint64(8, true)
    expect(amountRead).toBe(amountLamports)

    const recipientRead = ix.data.subarray(16, 48)
    expect(Uint8Array.from(recipientRead)).toEqual(recipient)

    const randomnessRead = ix.data.subarray(48, 80)
    expect(Uint8Array.from(randomnessRead)).toEqual(randomness)
  })
})
