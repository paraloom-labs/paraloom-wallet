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

describe("spendV3 settlement confirmation and error resilience (#196)", () => {
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

  it("uses Merkle tree commitment confirmation by default for withdrawals without custom confirmSettled", async () => {
    mockConfirmCommitmentInTree.mockResolvedValue(true)

    const res = await spendV3(
      dummyConnection,
      "shieldedAddress1",
      "spendPriv1",
      "boxPub1",
      [dummyNote],
      500_000_000n,
      { kind: "withdraw", recipientSolanaHex: "solanaRecipientHex" }
    )

    expect(mockConfirmCommitmentInTree).toHaveBeenCalled()
    expect(res.settled).toBe(true)
    expect(res.requestId).toBe("req-12345")
    expect(mockMarkNoteSpentByIdentity).toHaveBeenCalledTimes(1)
    expect(mockAddNote).toHaveBeenCalledTimes(1) // change note recorded
  })

  it("does not mark input notes spent or add change note when tree confirmation times out", async () => {
    mockConfirmCommitmentInTree.mockResolvedValue(false)

    const res = await spendV3(
      dummyConnection,
      "shieldedAddress1",
      "spendPriv1",
      "boxPub1",
      [dummyNote],
      500_000_000n,
      { kind: "withdraw", recipientSolanaHex: "solanaRecipientHex" }
    )

    expect(mockConfirmCommitmentInTree).toHaveBeenCalled()
    expect(res.settled).toBe(false)
    expect(res.requestId).toBe("req-12345")
    expect(mockMarkNoteSpentByIdentity).not.toHaveBeenCalled()
    expect(mockAddNote).not.toHaveBeenCalled()
  })

  it("catches errors in custom confirmSettled callback and handles gracefully as unsettled", async () => {
    const customConfirmThrowing = vi
      .fn()
      .mockRejectedValue(new Error("Transient RPC connection reset"))

    const res = await spendV3(
      dummyConnection,
      "shieldedAddress1",
      "spendPriv1",
      "boxPub1",
      [dummyNote],
      500_000_000n,
      { kind: "withdraw", recipientSolanaHex: "solanaRecipientHex" },
      { confirmSettled: customConfirmThrowing }
    )

    expect(customConfirmThrowing).toHaveBeenCalledTimes(1)
    expect(res.settled).toBe(false)
    expect(res.requestId).toBe("req-12345")
    expect(mockMarkNoteSpentByIdentity).not.toHaveBeenCalled()
    expect(mockAddNote).not.toHaveBeenCalled()
  })
})
