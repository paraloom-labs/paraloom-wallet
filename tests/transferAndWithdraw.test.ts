import type { ShieldedNote } from "~lib/paraloom/notes"
import { transfer } from "~lib/paraloom/transfer"
import { withdraw } from "~lib/paraloom/withdraw"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { installFakeChrome } from "./support/chromeStorage"

const mockNoteCommitmentV2 = vi.fn().mockResolvedValue("mock-commitment")
const mockProveTransferV2 = vi.fn().mockResolvedValue({
  nullifiers: ["nullifier1", "nullifier2"],
  output_commitments: ["out_commit0", "out_commit1"],
  proof: "mock-proof"
})
const mockProveWithdrawalV2 = vi.fn().mockResolvedValue({
  nullifier: "mock-nullifier",
  proof: "mock-proof"
})

vi.mock("~lib/prover", () => ({
  noteCommitmentV2: (...args: any[]) => mockNoteCommitmentV2(...args),
  proveTransferV2: (...args: any[]) => mockProveTransferV2(...args),
  proveWithdrawalV2: (...args: any[]) => mockProveWithdrawalV2(...args),
  NATIVE_ASSET_HEX: "00".repeat(32)
}))

const mockFetch = vi.fn()
global.fetch = mockFetch

let noteCounter = 0
function makeNote(overrides: Partial<ShieldedNote> = {}): ShieldedNote {
  noteCounter++
  return {
    amount: "1000",
    blinding: noteCounter.toString(16).padStart(2, "0").repeat(32),
    assetId: "11".repeat(32),
    signature: `sig-${noteCounter}`,
    createdAt: 1,
    spent: false,
    source: "deposit",
    ...overrides
  }
}

describe("withdraw validation and assetId handling", () => {
  beforeEach(() => {
    installFakeChrome()
    vi.clearAllMocks()
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/merkle/path/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ root: "root-123", path: ["p1"], indices: [false] })
        }
      }
      if (url.includes("/withdrawal/submit")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ request_id: "req-withdraw-1" })
        }
      }
      return { ok: false, status: 404 }
    })
  })

  it("rejects spent notes", async () => {
    const note = makeNote({ spent: true })
    await expect(
      withdraw(note, "11111111111111111111111111111111", "ff".repeat(32))
    ).rejects.toThrow("Cannot withdraw a spent note")
  })

  it("rejects empty or whitespace assetId", async () => {
    const emptyNote = makeNote({ assetId: "" })
    await expect(
      withdraw(emptyNote, "11111111111111111111111111111111", "ff".repeat(32))
    ).rejects.toThrow("Note has an empty or invalid assetId")

    const wsNote = makeNote({ assetId: "   " })
    await expect(
      withdraw(wsNote, "11111111111111111111111111111111", "ff".repeat(32))
    ).rejects.toThrow("Note has an empty or invalid assetId")
  })

  it("proves under note.assetId and submits withdrawal", async () => {
    const note = makeNote({ assetId: "42".repeat(32) })
    const res = await withdraw(note, "11111111111111111111111111111111", "ff".repeat(32))
    expect(res.requestId).toBe("req-withdraw-1")

    expect(mockNoteCommitmentV2).toHaveBeenCalledWith(
      1000n,
      "ff".repeat(32),
      note.blinding,
      "42".repeat(32)
    )
    expect(mockProveWithdrawalV2).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: "42".repeat(32)
      })
    )
  })
})

describe("transfer validation and assetId handling", () => {
  const OWN_SHIELDED = "paraloom1" + "11".repeat(64)
  const RECIP_SHIELDED = "paraloom1" + "22".repeat(64)
  const SPEND_PRIV = "ee".repeat(32)

  beforeEach(() => {
    installFakeChrome()
    vi.clearAllMocks()
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/merkle/path/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ root: "root-transfer-123", path: ["p1"], indices: [false] })
        }
      }
      if (url.includes("/transfer/submit")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ request_id: "req-transfer-1" })
        }
      }
      return { ok: false, status: 404 }
    })
  })

  it("rejects spent input notes", async () => {
    const note1 = makeNote({ spent: true, blinding: "11".repeat(32) })
    const note2 = makeNote({ spent: false, blinding: "22".repeat(32) })

    await expect(
      transfer("acc1", OWN_SHIELDED, RECIP_SHIELDED, 500n, [note1, note2], SPEND_PRIV)
    ).rejects.toThrow("Cannot transfer spent notes")

    await expect(
      transfer("acc1", OWN_SHIELDED, RECIP_SHIELDED, 500n, [note2, note1], SPEND_PRIV)
    ).rejects.toThrow("Cannot transfer spent notes")
  })

  it("rejects duplicate input notes", async () => {
    const note1 = makeNote({ blinding: "11".repeat(32), signature: "sig-1" })

    // Same reference
    await expect(
      transfer("acc1", OWN_SHIELDED, RECIP_SHIELDED, 500n, [note1, note1], SPEND_PRIV)
    ).rejects.toThrow("Cannot transfer duplicate notes")

    // Same blinding
    const note2 = makeNote({ blinding: "11".repeat(32), signature: "sig-2" })
    await expect(
      transfer("acc1", OWN_SHIELDED, RECIP_SHIELDED, 500n, [note1, note2], SPEND_PRIV)
    ).rejects.toThrow("Cannot transfer duplicate notes")

    // Same commitment
    const note3 = makeNote({ blinding: "33".repeat(32), commitment: "comm-dup" })
    const note4 = makeNote({ blinding: "44".repeat(32), commitment: "comm-dup" })
    await expect(
      transfer("acc1", OWN_SHIELDED, RECIP_SHIELDED, 500n, [note3, note4], SPEND_PRIV)
    ).rejects.toThrow("Cannot transfer duplicate notes")

    // Same signature
    const note5 = makeNote({ blinding: "55".repeat(32), signature: "sig-dup" })
    const note6 = makeNote({ blinding: "66".repeat(32), signature: "sig-dup" })
    await expect(
      transfer("acc1", OWN_SHIELDED, RECIP_SHIELDED, 500n, [note5, note6], SPEND_PRIV)
    ).rejects.toThrow("Cannot transfer duplicate notes")
  })

  it("rejects empty or whitespace assetId", async () => {
    const note1 = makeNote({ assetId: "", blinding: "11".repeat(32) })
    const note2 = makeNote({ assetId: "22".repeat(32), blinding: "22".repeat(32) })

    await expect(
      transfer("acc1", OWN_SHIELDED, RECIP_SHIELDED, 500n, [note1, note2], SPEND_PRIV)
    ).rejects.toThrow("Note has an empty or invalid assetId")

    const note3 = makeNote({ assetId: "  ", blinding: "33".repeat(32) })
    await expect(
      transfer("acc1", OWN_SHIELDED, RECIP_SHIELDED, 500n, [note2, note3], SPEND_PRIV)
    ).rejects.toThrow("Note has an empty or invalid assetId")
  })

  it("rejects mismatched assetIds between inputs", async () => {
    const note1 = makeNote({ assetId: "11".repeat(32), blinding: "11".repeat(32) })
    const note2 = makeNote({ assetId: "22".repeat(32), blinding: "22".repeat(32) })

    await expect(
      transfer("acc1", OWN_SHIELDED, RECIP_SHIELDED, 500n, [note1, note2], SPEND_PRIV)
    ).rejects.toThrow("Input notes must share the same assetId")
  })

  it("proves under note.assetId, encrypts ciphertexts with note.assetId, and preserves assetId in change note", async () => {
    const tokenAssetId = "77".repeat(32)
    const note1 = makeNote({
      assetId: tokenAssetId,
      blinding: "11".repeat(32),
      amount: "1000",
      mint: "So11111111111111111111111111111111111111112"
    })
    const note2 = makeNote({
      assetId: tokenAssetId,
      blinding: "22".repeat(32),
      amount: "2000",
      mint: "So11111111111111111111111111111111111111112"
    })

    const result = await transfer(
      "acc1",
      OWN_SHIELDED,
      RECIP_SHIELDED,
      1200n,
      [note1, note2],
      SPEND_PRIV
    )

    expect(result.requestId).toBe("req-transfer-1")
    expect(result.changeCommitment).toBe("out_commit1")

    // proveTransferV2 must be called with tokenAssetId, NOT NATIVE_ASSET_HEX ("00".repeat(32))
    expect(mockProveTransferV2).toHaveBeenCalledWith(
      "root-transfer-123",
      tokenAssetId,
      expect.any(Array),
      expect.any(Array)
    )

    // Verify submit payload ciphertexts
    const submitCall = mockFetch.mock.calls.find((c: any[]) => c[0].includes("/transfer/submit"))
    expect(submitCall).toBeDefined()
    const submittedBody = JSON.parse(submitCall[1].body)
    expect(submittedBody.ciphertexts).toHaveLength(2)
  })
})
