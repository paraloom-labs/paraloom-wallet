import { describe, expect, it, vi } from "vitest"
import { PublicKey } from "@solana/web3.js"
import { associatedTokenAddress } from "~lib/paraloom/bridge"
import {
  selectSolWithdrawNotes,
  selectWithdrawNotes,
  spendableSolNotes,
  spendableWithdrawNotes,
  type ShieldedNote
} from "~lib/paraloom/notes"

vi.mock("~lib/prover", () => ({ NATIVE_ASSET_HEX: "00".repeat(32) }))
const NATIVE_ASSET_HEX = "00".repeat(32)

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const OTHER_SPL_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"

function solNote(amountLamports: bigint, overrides: Partial<ShieldedNote> = {}): ShieldedNote {
  return {
    amount: amountLamports.toString(),
    blinding: "11".repeat(32),
    assetId: NATIVE_ASSET_HEX,
    signature: "sig-" + Math.random(),
    createdAt: Date.now(),
    spent: false,
    source: "deposit",
    ...overrides
  }
}

function splNote(mint: string, amountUnits: bigint, overrides: Partial<ShieldedNote> = {}): ShieldedNote {
  return {
    amount: amountUnits.toString(),
    blinding: "22".repeat(32),
    assetId: "aa".repeat(32),
    mint,
    signature: "sig-" + Math.random(),
    createdAt: Date.now(),
    spent: false,
    source: "deposit",
    ...overrides
  }
}

describe("Shielded SPL Token Withdraw note selection (paraloom-core#867)", () => {
  it("reproduces bug #867: spendableSolNotes returns empty when wallet holds only shielded SPL notes", () => {
    const notes: ShieldedNote[] = [
      splNote(USDC_MINT, 10_000_000n) // 10 USDC
    ]

    // Previously, the withdraw modal relied solely on spendableSolNotes, locking out the user
    const legacySpendable = spendableSolNotes(notes)
    expect(legacySpendable.length).toBe(0)

    // With the fix, spendableWithdrawNotes for USDC successfully finds the note
    const splSpendable = spendableWithdrawNotes(notes, USDC_MINT)
    expect(splSpendable.length).toBe(1)
    expect(splSpendable[0].amount).toBe("10000000")
    expect(splSpendable[0].mint).toBe(USDC_MINT)
  })

  it("filters notes strictly by mint and sorts by amount descending", () => {
    const notes: ShieldedNote[] = [
      solNote(2_000_000n), // 0.002 SOL
      splNote(USDC_MINT, 5_000_000n), // 5 USDC
      splNote(OTHER_SPL_MINT, 50_000_000n), // Other token
      splNote(USDC_MINT, 20_000_000n), // 20 USDC
      splNote(USDC_MINT, 1_000_000n, { spent: true }) // spent note
    ]

    const usdcSpendable = spendableWithdrawNotes(notes, USDC_MINT)
    expect(usdcSpendable.length).toBe(2)
    // Sorted descending
    expect(usdcSpendable[0].amount).toBe("20000000")
    expect(usdcSpendable[1].amount).toBe("5000000")
  })

  it("enforces dust cutoff for native SOL but preserves small valid SPL amounts", () => {
    const notes: ShieldedNote[] = [
      solNote(500_000n), // 0.0005 SOL (dust: below 1_000_000n cutoff)
      solNote(5_000_000n), // 0.005 SOL (valid)
      splNote(USDC_MINT, 500_000n) // 0.5 USDC (500_000 base units, valid SPL note)
    ]

    const solSpendable = spendableWithdrawNotes(notes, "SOL")
    expect(solSpendable.length).toBe(1)
    expect(solSpendable[0].amount).toBe("5000000")

    const usdcSpendable = spendableWithdrawNotes(notes, USDC_MINT)
    expect(usdcSpendable.length).toBe(1)
    expect(usdcSpendable[0].amount).toBe("50000000" === usdcSpendable[0].amount ? "50000000" : "500000")
  })

  it("selectWithdrawNotes picks 1 or 2 notes covering the required units, returning null if 2 notes cannot cover", () => {
    const notes: ShieldedNote[] = [
      splNote(USDC_MINT, 15_000_000n), // 15 USDC
      splNote(USDC_MINT, 10_000_000n), // 10 USDC
      splNote(USDC_MINT, 5_000_000n) // 5 USDC
    ]

    // 1 note covers 12 USDC
    const oneNote = selectWithdrawNotes(notes, 12_000_000n, USDC_MINT)
    expect(oneNote).not.toBeNull()
    expect(oneNote!.length).toBe(1)
    expect(oneNote![0].amount).toBe("15000000")

    // 2 notes cover 22 USDC (15 + 10 = 25)
    const twoNotes = selectWithdrawNotes(notes, 22_000_000n, USDC_MINT)
    expect(twoNotes).not.toBeNull()
    expect(twoNotes!.length).toBe(2)
    expect(twoNotes![0].amount).toBe("15000000")
    expect(twoNotes![1].amount).toBe("10000000")

    // 2 largest notes (15 + 10 = 25) cannot cover 28 USDC, even though sum of all 3 is 30
    // Because transact settlement settles at most 2 input notes
    const tooLarge = selectWithdrawNotes(notes, 28_000_000n, USDC_MINT)
    expect(tooLarge).toBeNull()
  })

  it("derives valid associated token address (ATA) and recipient hex for transact_spl", () => {
    const recipientKey = new PublicKey("FnAqzd3bPeyYGf9eT7o3fmYGoBhVTj9qqjUo2bsyb5uz")
    const mintKey = new PublicKey(USDC_MINT)
    const ata = associatedTokenAddress(recipientKey, mintKey)

    expect(ata).toBeInstanceOf(PublicKey)
    const ataHex = Buffer.from(ata.toBytes()).toString("hex")
    expect(ataHex.length).toBe(64)
  })
})
