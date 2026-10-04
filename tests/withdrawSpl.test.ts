import { describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  assetIdForMint: vi.fn().mockResolvedValue("11".repeat(32))
}))

import { PublicKey } from "@solana/web3.js"
import {
  spendableWithdrawNotes,
  selectWithdrawNotes,
  spendableSolNotes,
  selectSolWithdrawNotes,
  WITHDRAW_DUST_LAMPORTS,
  type ShieldedNote
} from "~lib/paraloom/notes"
import { associatedTokenAddress } from "~lib/paraloom/bridge"

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const OTHER_TOKEN_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
const NATIVE_ASSET_HEX = "00".repeat(32)
const USDC_ASSET_HEX = "11".repeat(32)

function mockNote(overrides: Partial<ShieldedNote> = {}): ShieldedNote {
  return {
    amount: "1000000000", // 1 SOL
    blinding: "aa".repeat(32),
    assetId: NATIVE_ASSET_HEX,
    signature: "sig-" + Math.random().toString(36).slice(2),
    createdAt: Date.now(),
    spent: false,
    ...overrides
  }
}

describe("Withdraw Note Selection (#867)", () => {
  it("reproduces Bug #867: spendableSolNotes returns empty when holding only shielded SPL notes, locking out withdrawal", () => {
    const notes: ShieldedNote[] = [
      mockNote({
        amount: "50000000", // 50 USDC
        assetId: USDC_ASSET_HEX,
        mint: USDC_MINT,
        spent: false
      })
    ]

    // Old behavior: strictly filtered for native SOL, so spendable was empty
    expect(spendableSolNotes(notes)).toEqual([])
    expect(selectSolWithdrawNotes(notes, 10000000n)).toBeNull()

    // New behavior: spendableWithdrawNotes discovers the shielded token
    const spendableUsdc = spendableWithdrawNotes(notes, USDC_MINT)
    expect(spendableUsdc).toHaveLength(1)
    expect(spendableUsdc[0].amount).toBe("50000000")
    expect(spendableUsdc[0].mint).toBe(USDC_MINT)

    const selected = selectWithdrawNotes(notes, 10000000n, USDC_MINT)
    expect(selected).not.toBeNull()
    expect(selected).toHaveLength(1)
  })

  it("strictly filters notes by mint and excludes spent notes", () => {
    const notes: ShieldedNote[] = [
      mockNote({ amount: "2000000000", mint: undefined }), // 2 SOL
      mockNote({ amount: "10000000", mint: USDC_MINT }), // 10 USDC
      mockNote({ amount: "20000000", mint: USDC_MINT, spent: true }), // spent USDC
      mockNote({ amount: "5000000", mint: OTHER_TOKEN_MINT }) // other token
    ]

    const solNotes = spendableWithdrawNotes(notes, "SOL")
    expect(solNotes).toHaveLength(1)
    expect(solNotes[0].amount).toBe("2000000000")

    const usdcNotes = spendableWithdrawNotes(notes, USDC_MINT)
    expect(usdcNotes).toHaveLength(1)
    expect(usdcNotes[0].amount).toBe("10000000")

    const otherNotes = spendableWithdrawNotes(notes, OTHER_TOKEN_MINT)
    expect(otherNotes).toHaveLength(1)
    expect(otherNotes[0].amount).toBe("5000000")
  })

  it("applies dust threshold only to native SOL, preserving fractional SPL tokens", () => {
    const notes: ShieldedNote[] = [
      mockNote({ amount: "500000", mint: undefined }), // 0.0005 SOL (below 0.001 SOL dust)
      mockNote({ amount: "2000000", mint: undefined }), // 0.002 SOL (above dust)
      mockNote({ amount: "50000", mint: USDC_MINT }) // 0.05 USDC (50k base units, fractional but valid)
    ]

    const solNotes = spendableWithdrawNotes(notes, "SOL")
    expect(solNotes).toHaveLength(1)
    expect(solNotes[0].amount).toBe("2000000")

    const usdcNotes = spendableWithdrawNotes(notes, USDC_MINT)
    expect(usdcNotes).toHaveLength(1)
    expect(usdcNotes[0].amount).toBe("50000")
  })

  it("selects up to 2 notes covering the target amount, sorted largest first", () => {
    const notes: ShieldedNote[] = [
      mockNote({ amount: "10000000", mint: USDC_MINT }), // 10 USDC
      mockNote({ amount: "30000000", mint: USDC_MINT }), // 30 USDC
      mockNote({ amount: "5000000", mint: USDC_MINT }) // 5 USDC
    ]

    // 25 USDC: single 30 USDC note covers it
    const pick1 = selectWithdrawNotes(notes, 25000000n, USDC_MINT)
    expect(pick1).toHaveLength(1)
    expect(pick1![0].amount).toBe("30000000")

    // 35 USDC: 30 + 10 covers it (2 notes)
    const pick2 = selectWithdrawNotes(notes, 35000000n, USDC_MINT)
    expect(pick2).toHaveLength(2)
    expect(pick2![0].amount).toBe("30000000")
    expect(pick2![1].amount).toBe("10000000")

    // 50 USDC: all 3 notes total 45 USDC, max 2 notes is 40 USDC -> returns null
    const pick3 = selectWithdrawNotes(notes, 50000000n, USDC_MINT)
    expect(pick3).toBeNull()
  })

  it("derives the correct ATA recipient and encodes 32-byte hex for transact_spl", () => {
    const recipientOwner = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")
    const mint = new PublicKey(USDC_MINT)

    const ata = associatedTokenAddress(recipientOwner, mint)
    expect(ata).toBeInstanceOf(PublicKey)

    const recipientHex = ata.toBuffer().toString("hex")
    expect(recipientHex).toHaveLength(64)
    expect(new PublicKey(Buffer.from(recipientHex, "hex")).toBase58()).toBe(ata.toBase58())
  })
})
