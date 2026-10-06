import { describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({ NATIVE_ASSET_HEX: "00".repeat(32) }))
vi.mock("~lib/paraloom/transact", () => ({
  fetchV3Leaves: vi.fn().mockRejectedValue(new Error("reached-tree-fetch")),
  sendDepositNote: vi.fn(),
  submitTransact: vi.fn(),
}))

import { NATIVE_ASSET_HEX } from "../lib/prover"
import type { ShieldedNote } from "../lib/paraloom/notes"
import { unspentSolNotes, selectSolTransferNotes } from "../src/popup/Home"
import { spendV3 } from "../lib/paraloom/transactFlow"

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

describe("shielded transfer note selection (paraloom-core#852)", () => {
  const dummyNote = (
    amount: bigint,
    assetId: string = NATIVE_ASSET_HEX,
    spent = false,
    mint?: string
  ): ShieldedNote => ({
    amount: amount.toString(),
    blinding: "00".repeat(32),
    assetId,
    mint,
    signature: "sig123",
    createdAt: Date.now(),
    spent,
  })

  const SPL_ASSET = "11".repeat(32)

  it("unspentSolNotes filters out spent notes and SPL token notes", () => {
    const sol1 = dummyNote(1_000_000_000n, NATIVE_ASSET_HEX)
    const sol2 = dummyNote(2_000_000_000n, "")
    const spentSol = dummyNote(5_000_000_000n, NATIVE_ASSET_HEX, true)
    const splNote = dummyNote(10_000_000_000n, SPL_ASSET, false, USDC_MINT)

    const filtered = unspentSolNotes([sol1, spentSol, splNote, sol2])
    expect(filtered).toHaveLength(2)
    expect(filtered.map((n) => n.amount)).toEqual(["2000000000", "1000000000"])
  })

  it("selectSolTransferNotes picks the largest native SOL notes without touching SPL notes", () => {
    const smallSol = dummyNote(500_000_000n, NATIVE_ASSET_HEX)
    const largeSpl = dummyNote(50_000_000_000n, SPL_ASSET, false, USDC_MINT)
    const midSol = dummyNote(800_000_000n, NATIVE_ASSET_HEX)

    const selected = selectSolTransferNotes([smallSol, largeSpl, midSol], 1_000_000_000n)
    expect(selected).not.toBeNull()
    expect(selected!).toHaveLength(2)
    expect(selected!.every((n) => !n.assetId || n.assetId === NATIVE_ASSET_HEX)).toBe(true)
    expect(selected!.some((n) => n.assetId === SPL_ASSET)).toBe(false)
  })

  it("returns null if native SOL notes cannot cover the requested amount", () => {
    const smallSol = dummyNote(100_000_000n, NATIVE_ASSET_HEX)
    const hugeSpl = dummyNote(1_000_000_000_000n, SPL_ASSET, false, USDC_MINT)

    const selected = selectSolTransferNotes([smallSol, hugeSpl], 500_000_000n)
    expect(selected).toBeNull()
  })

  it("selectSolTransferNotes returns a single note when it covers the amount", () => {
    const bigSol = dummyNote(5_000_000_000n, NATIVE_ASSET_HEX)
    const smallSol = dummyNote(100_000_000n, NATIVE_ASSET_HEX)

    const selected = selectSolTransferNotes([smallSol, bigSol], 1_000_000_000n)
    expect(selected).not.toBeNull()
    expect(selected!).toHaveLength(1)
    expect(selected![0].amount).toBe("5000000000")
  })

  it("spendV3 rejects SPL token notes for shielded transfers", async () => {
    const splNote = dummyNote(1_000_000_000n, SPL_ASSET, false, USDC_MINT)
    const conn = {} as Parameters<typeof spendV3>[0]

    await expect(
      spendV3(
        conn,
        "paraloom1" + "11".repeat(64),
        "aa".repeat(64),
        "bb".repeat(64),
        [splNote],
        500_000_000n,
        { kind: "transfer", recipientShielded: "paraloom1" + "22".repeat(64) }
      )
    ).rejects.toThrow("shielded transfers spend native SOL notes only")
  })

  it("spendV3 allows SPL token notes for withdraw (guard is transfer-only)", async () => {
    const splNote = dummyNote(1_000_000_000n, SPL_ASSET, false, USDC_MINT)
    const conn = {} as Parameters<typeof spendV3>[0]

    await expect(
      spendV3(
        conn,
        "paraloom1" + "11".repeat(64),
        "aa".repeat(64),
        "bb".repeat(64),
        [splNote],
        500_000_000n,
        { kind: "withdraw", recipientSolanaHex: "cc".repeat(64) }
      )
    ).rejects.toThrow("reached-tree-fetch")
  })
})
