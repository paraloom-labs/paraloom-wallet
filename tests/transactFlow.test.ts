import type { Connection } from "@solana/web3.js"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ShieldedNote } from "../lib/paraloom/notes"
import { spendV3 } from "../lib/paraloom/transactFlow"

const mockProveTransact = vi.fn()
const mockSubmitTransact = vi.fn()
const mockConfirmCommitmentInTree = vi.fn()
const mockMarkNoteSpentByIdentity = vi.fn()
const mockAddNote = vi.fn()
const mockFetchV3Leaves = vi.fn()

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  proveTransact: (...args: unknown[]) => mockProveTransact(...args),
  v3MerklePath: vi.fn().mockResolvedValue({ path: ["00".repeat(32)], root: "11".repeat(32) }),
  v3NoteCommitment: vi.fn().mockResolvedValue("mock-commitment"),
  v3NoteCommitmentAsset: vi.fn(),
  v3NotePubkey: vi.fn().mockResolvedValue("mock-pubkey")
}))

vi.mock("~lib/crypto/keyManagement", () => ({
  addressBoxPubHex: vi.fn().mockReturnValue("mock-box-pub"),
  addressSpendPubHex: vi.fn().mockReturnValue("mock-spend-pub")
}))

vi.mock("../lib/paraloom/noteCrypto", () => ({
  encryptNote: vi.fn().mockReturnValue("mock-ciphertext")
}))

vi.mock("../lib/paraloom/notes", () => ({
  markNoteSpentByIdentity: (...args: unknown[]) => mockMarkNoteSpentByIdentity(...args),
  addNote: (...args: unknown[]) => mockAddNote(...args)
}))

vi.mock("../lib/paraloom/settlementConfirm", () => ({
  confirmCommitmentInTree: (...args: unknown[]) => mockConfirmCommitmentInTree(...args)
}))

vi.mock("../lib/paraloom/transact", () => ({
  fetchV3Leaves: (...args: unknown[]) => mockFetchV3Leaves(...args),
  submitTransact: (...args: unknown[]) => mockSubmitTransact(...args)
}))

describe("spendV3 expectedAssetIdHex guard (#195)", () => {
  const dummyConnection = {} as Connection
  const dummyNote: ShieldedNote = {
    amount: "1000000000",
    blinding: "11".repeat(32),
    assetId: "00".repeat(32),
    signature: "sig1",
    createdAt: Date.now(),
    spent: false,
    source: "deposit",
    commitment: "comm1",
    leafIndex: 0
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchV3Leaves.mockResolvedValue([{ commitmentHex: "comm1" }])
    mockProveTransact.mockResolvedValue({ proof: "mock-proof" })
    mockSubmitTransact.mockResolvedValue({ requestId: "req-12345" })
    mockConfirmCommitmentInTree.mockResolvedValue(true)
    mockMarkNoteSpentByIdentity.mockResolvedValue(undefined)
    mockAddNote.mockResolvedValue(undefined)
  })

  it("enforces expectedAssetIdHex guard to reject cross-asset note spending", async () => {
    const splNote: ShieldedNote = {
      ...dummyNote,
      assetId: "55".repeat(32),
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    }

    // Calling native SOL flow with an SPL note should be rejected
    await expect(
      spendV3(
        dummyConnection,
        "shieldedAddress1",
        "spendPriv1",
        "boxPub1",
        [splNote],
        500_000_000n,
        { kind: "withdraw", recipientSolanaHex: "solanaRecipientHex" },
        { expectedAssetIdHex: "00".repeat(32) }
      )
    ).rejects.toThrow("expected asset")
  })

  it("accepts notes matching expectedAssetIdHex", async () => {
    const res = await spendV3(
      dummyConnection,
      "shieldedAddress1",
      "spendPriv1",
      "boxPub1",
      [dummyNote],
      500_000_000n,
      { kind: "withdraw", recipientSolanaHex: "solanaRecipientHex" },
      {
        expectedAssetIdHex: "00".repeat(32),
        confirmSettled: async () => true
      }
    )

    expect(res.settled).toBe(true)
  })
})
