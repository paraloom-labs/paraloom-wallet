import { describe, expect, it } from "vitest"
import { NATIVE_ASSET_HEX } from "../lib/paraloom/constants"
import type { ShieldedNote } from "../lib/paraloom/notes"
import {
  maxSolWithdrawLamports,
  selectSolWithdrawNotes,
  spendableSolNotes,
  WITHDRAW_DUST_LAMPORTS
} from "../lib/paraloom/noteSelection"

function makeNote(amount: bigint | string, assetId?: string, spent = false): ShieldedNote {
  return {
    amount: amount.toString(),
    blinding: "11".repeat(32),
    assetId: assetId ?? NATIVE_ASSET_HEX,
    signature: "sig",
    createdAt: Date.now(),
    spent,
    source: "deposit",
    commitment: "comm"
  }
}

describe("noteSelection (#195)", () => {
  const USDC_ASSET = "55".repeat(32)

  describe("spendableSolNotes", () => {
    it("filters out spent notes and SPL token notes", () => {
      const notes: ShieldedNote[] = [
        makeNote(50_000_000n), // 0.05 SOL native, unspent
        makeNote(100_000_000n, NATIVE_ASSET_HEX, true), // spent
        makeNote(500_000_000n, USDC_ASSET), // SPL USDC note
        makeNote(20_000_000n) // 0.02 SOL native, unspent
      ]

      const spendable = spendableSolNotes(notes)
      expect(spendable.length).toBe(2)
      expect(spendable[0].amount).toBe("50000000")
      expect(spendable[1].amount).toBe("20000000")
    })

    it("filters out individual sub-dust notes (< 0.001 SOL)", () => {
      const notes: ShieldedNote[] = [
        makeNote(50_000_000n),
        makeNote(500_000n), // 0.0005 SOL (dust)
        makeNote(1_000_000n) // 0.001 SOL (boundary, kept)
      ]

      const spendable = spendableSolNotes(notes)
      expect(spendable.length).toBe(2)
      expect(spendable[0].amount).toBe("50000000")
      expect(spendable[1].amount).toBe("1000000")
    })

    it("sorts correctly without IEEE-754 precision loss on large note amounts", () => {
      const hugeA = 9_007_199_254_740_995n
      const hugeB = 9_007_199_254_740_993n
      const notes: ShieldedNote[] = [makeNote(hugeB), makeNote(hugeA)]

      const spendable = spendableSolNotes(notes)
      expect(spendable[0].amount).toBe(hugeA.toString())
      expect(spendable[1].amount).toBe(hugeB.toString())
    })
  })

  describe("maxSolWithdrawLamports", () => {
    it("returns 0n when no notes exist or when notes are sub-dust", () => {
      expect(maxSolWithdrawLamports([])).toBe(0n)
      expect(maxSolWithdrawLamports([makeNote(400_000n)])).toBe(0n)
      expect(maxSolWithdrawLamports([makeNote(300_000n), makeNote(400_000n)])).toBe(0n) // sum 700k < 1M
    })

    it("includes sub-dust change note in top 2 when primary note is >= dust", () => {
      const notes = [
        makeNote(50_000_000n), // 0.05 SOL
        makeNote(400_000n) // 0.0004 SOL change note
      ]
      expect(maxSolWithdrawLamports(notes)).toBe(50_400_000n)
    })

    it("allows two sub-dust notes when their combined sum is >= dust", () => {
      const notes = [
        makeNote(600_000n), // 0.0006 SOL
        makeNote(500_000n) // 0.0005 SOL
      ]
      expect(maxSolWithdrawLamports(notes)).toBe(1_100_000n)
    })

    it("ignores SPL token notes", () => {
      const notes = [makeNote(1_000_000_000n, USDC_ASSET), makeNote(20_000_000n)]
      expect(maxSolWithdrawLamports(notes)).toBe(20_000_000n)
    })
  })

  describe("selectSolWithdrawNotes", () => {
    it("selects a single note >= dust that covers lamports", () => {
      const notes = [
        makeNote(100_000_000n), // 0.1 SOL
        makeNote(50_000_000n) // 0.05 SOL
      ]
      // For 0.04 SOL, selects the cleanest fit 0.05 SOL note alone
      const selected = selectSolWithdrawNotes(notes, 40_000_000n)
      expect(selected).not.toBeNull()
      expect(selected!.length).toBe(1)
      expect(selected![0].amount).toBe("50000000")
    })

    it("rejects single sub-dust note if it cannot reach WITHDRAW_DUST_LAMPORTS", () => {
      const notes = [makeNote(400_000n)]
      expect(selectSolWithdrawNotes(notes, 200_000n)).toBeNull()
    })

    it("pairs sub-0.001 SOL change note as second note alongside primary note >= dust", () => {
      const notes = [
        makeNote(50_000_000n), // 0.05 SOL
        makeNote(400_000n) // 0.0004 SOL change note
      ]
      // User withdraws 0.0503 SOL (more than Note 1 alone)
      const selected = selectSolWithdrawNotes(notes, 50_300_000n)
      expect(selected).not.toBeNull()
      expect(selected!.length).toBe(2)
      expect(selected![0].amount).toBe("50000000")
      expect(selected![1].amount).toBe("400000")
    })

    it("sweeps sub-0.001 SOL change note when pairing instead of breaking larger note", () => {
      const notes = [
        makeNote(50_000_000n), // 0.05 SOL
        makeNote(20_000_000n), // 0.02 SOL
        makeNote(400_000n) // 0.0004 SOL change note
      ]
      // 0.0503 SOL: Note 1 (50M) + Note 3 (400k) covers 50.3M; leaves Note 2 (20M) unspent
      const selected = selectSolWithdrawNotes(notes, 50_300_000n)
      expect(selected).not.toBeNull()
      expect(selected!.length).toBe(2)
      expect(selected![0].amount).toBe("50000000")
      expect(selected![1].amount).toBe("400000")
    })

    it("pairs two sub-dust notes when their combined sum is >= dust and >= lamports", () => {
      const notes = [makeNote(600_000n), makeNote(500_000n)]
      const selected = selectSolWithdrawNotes(notes, 1_050_000n)
      expect(selected).not.toBeNull()
      expect(selected!.length).toBe(2)
      expect(selected![0].amount).toBe("600000")
      expect(selected![1].amount).toBe("500000")
    })

    it("never selects SPL token notes even if they have larger raw integer amounts", () => {
      const notes = [
        makeNote(1_000_000_000n, USDC_ASSET), // 1000 USDC
        makeNote(50_000_000n) // 0.05 SOL
      ]
      // 0.04 SOL withdraw
      const selected = selectSolWithdrawNotes(notes, 40_000_000n)
      expect(selected).not.toBeNull()
      expect(selected!.length).toBe(1)
      expect(selected![0].amount).toBe("50000000")
      expect(selected![0].assetId).toBe(NATIVE_ASSET_HEX)
    })

    it("returns null if 2 notes cannot cover the requested lamports", () => {
      const notes = [makeNote(50_000_000n), makeNote(20_000_000n)]
      expect(selectSolWithdrawNotes(notes, 80_000_000n)).toBeNull()
    })
  })
})
