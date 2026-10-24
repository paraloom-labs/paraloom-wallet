import { describe, expect, it, vi } from "vitest"
import { Keypair } from "@solana/web3.js"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  v3NotePubkey: vi.fn(async () => "01".repeat(32)),
  v3NoteCommitment: vi.fn(async () => "02".repeat(32)),
  v3NoteCommitmentAsset: vi.fn(async () => "02".repeat(32)),
  v3MerklePath: vi.fn(async (leavesHex: string[], index: number) => ({
    path: new Array(32).fill(index.toString().padStart(64, "0")),
    root: "03".repeat(32)
  })),
  proveTransact: vi.fn(async () => ({}))
}))

vi.mock("~lib/crypto/keyManagement", () => ({
  addressBoxPubHex: vi.fn(() => "04".repeat(32)),
  addressSpendPubHex: vi.fn(() => "05".repeat(32))
}))

vi.mock("~lib/paraloom/noteCrypto", () => ({
  encryptNote: vi.fn(() => "06".repeat(32))
}))

vi.mock("~lib/paraloom/notes", () => ({
  addNote: vi.fn(async () => {}),
  markNoteSpentByIdentity: vi.fn(async () => {}),
  setNoteLeafIndex: vi.fn(async () => {})
}))

vi.mock("~lib/paraloom/transact", () => ({
  sendDepositNote: vi.fn(async () => "mock-deposit-sig"),
  fetchV3Leaves: vi.fn(async () => [{ commitmentHex: "02".repeat(32) }]),
  submitTransact: vi.fn(async () => ({ requestId: "mock-request-id" }))
}))

vi.mock("~lib/paraloom/settlementConfirm", () => ({
  confirmCommitmentInTree: vi.fn(async () => true)
}))

import { depositV3, spendV3 } from "~lib/paraloom/transactFlow"
import { v3MerklePath } from "~lib/prover"

describe("transactFlow hardening (#113)", () => {
  it("depositV3 extracts valid safe integer leafIndex from logs", async () => {
    const fakeConnection: any = {
      getTransaction: vi.fn(async () => ({
        meta: {
          logMessages: ["Program log: Deposit note appended at leaf 12345"]
        }
      }))
    }
    const wallet = Keypair.generate()
    const res = await depositV3(fakeConnection, wallet, "shielded-addr", "01".repeat(32), 1000n)
    expect(res.leafIndex).toBe(12345)
  })

  it("depositV3 throws when leafIndex exceeds Number.MAX_SAFE_INTEGER", async () => {
    const hugeIndex = (BigInt(Number.MAX_SAFE_INTEGER) + 100n).toString()
    const fakeConnection: any = {
      getTransaction: vi.fn(async () => ({
        meta: {
          logMessages: [`Program log: Deposit note appended at leaf ${hugeIndex}`]
        }
      }))
    }
    const wallet = Keypair.generate()
    await expect(
      depositV3(fakeConnection, wallet, "shielded-addr", "01".repeat(32), 1000n)
    ).rejects.toThrow(/exceeds safe integer precision/)
  })

  it("spendV3 uses leaf 0 Merkle path for single-note dummy input padding", async () => {
    const fakeConnection: any = {}
    const singleInput: any = [
      {
        amount: "1000",
        blinding: "00".repeat(32),
        leafIndex: 42,
        assetId: "00".repeat(32)
      }
    ]

    await spendV3(
      fakeConnection,
      "shielded-addr",
      "01".repeat(32),
      "02".repeat(32),
      singleInput,
      500n,
      {
        kind: "transfer",
        recipientShielded: "recipient-shielded"
      },
      {
        confirmSettled: async () => true
      }
    )

    // Should call v3MerklePath for input note (leaf 42) AND dummy input (leaf 0)
    expect(v3MerklePath).toHaveBeenCalledWith(expect.any(Array), 42)
    expect(v3MerklePath).toHaveBeenCalledWith(expect.any(Array), 0)
  })
})
