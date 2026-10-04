import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { Connection, Keypair, PublicKey } from "@solana/web3.js"
import { depositSpl } from "~lib/paraloom/bridge"
import {
  getNotes,
  retirePendingNotes,
  shieldedTokenBalances
} from "~lib/paraloom/notes"
import { persistReshieldedNote } from "~lib/paraloom/reshieldRecovery"
import { installFakeChrome } from "./support/chromeStorage"

// Mock prover wasm import
vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  assetIdForMint: vi.fn().mockResolvedValue("11".repeat(32))
}))

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
const SHIELDED_ADDR = "paraloom1" + "aa".repeat(64)
const ASSET_ID = "11".repeat(32)

describe("depositSpl confirmation timeout (#853)", () => {
  beforeEach(() => {
    installFakeChrome()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("throws on confirmation timeout and keeps early note as pending without crediting balance", async () => {
    const depositor = Keypair.generate()
    const mockConnection = {
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "11111111111111111111111111111111" }),
      sendRawTransaction: vi.fn().mockResolvedValue("dropped-signature-123"),
      getSignatureStatus: vi.fn().mockResolvedValue({ value: null })
    } as unknown as Connection

    let earlySubmittedSig = ""
    const depositPromise = depositSpl(
      mockConnection,
      depositor,
      SHIELDED_ADDR,
      USDC_MINT,
      1_000_000n,
      ASSET_ID,
      undefined,
      async (result) => {
        earlySubmittedSig = result.signature
        await persistReshieldedNote(
          SHIELDED_ADDR,
          {
            assetId: ASSET_ID,
            mint: USDC_MINT.toBase58(),
            amount: "1000000",
            blindingHex: Buffer.from(result.blinding).toString("hex"),
            depositSignature: result.signature
          },
          true // pending
        )
      }
    )

    // Attach error handler so unhandled rejection does not fail before timer advance
    depositPromise.catch(() => {})

    // Advance past the 90-second confirmation deadline
    await vi.advanceTimersByTimeAsync(95_000)

    await expect(depositPromise).rejects.toThrow("deposit confirmation timed out for dropped-signature-123")
    expect(earlySubmittedSig).toBe("dropped-signature-123")

    // Note is safely stored to protect blinding (#791), but pending: true
    const storedNotes = await getNotes(SHIELDED_ADDR)
    expect(storedNotes).toHaveLength(1)
    expect(storedNotes[0].signature).toBe("dropped-signature-123")
    expect(storedNotes[0].pending).toBe(true)

    // Crucial check: balance is NOT credited while unconfirmed/timed out!
    const balances = await shieldedTokenBalances(SHIELDED_ADDR)
    expect(balances[USDC_MINT.toBase58()]).toBeUndefined()
  })

  it("resolves and promotes note to confirmed when signature status is confirmed", async () => {
    const depositor = Keypair.generate()
    const mockConnection = {
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "11111111111111111111111111111111" }),
      sendRawTransaction: vi.fn().mockResolvedValue("confirmed-signature-456"),
      getSignatureStatus: vi.fn().mockResolvedValue({
        value: {
          confirmationStatus: "confirmed",
          err: null
        }
      })
    } as unknown as Connection

    const depositPromise = depositSpl(
      mockConnection,
      depositor,
      SHIELDED_ADDR,
      USDC_MINT,
      1_000_000n,
      ASSET_ID,
      undefined,
      async (result) => {
        await persistReshieldedNote(
          SHIELDED_ADDR,
          {
            assetId: ASSET_ID,
            mint: USDC_MINT.toBase58(),
            amount: "1000000",
            blindingHex: Buffer.from(result.blinding).toString("hex"),
            depositSignature: result.signature
          },
          true // pending on submit
        )
      }
    )

    const res = await depositPromise
    expect(res.signature).toBe("confirmed-signature-456")

    // On completion, persist confirmed note
    await persistReshieldedNote(
      SHIELDED_ADDR,
      {
        assetId: ASSET_ID,
        mint: USDC_MINT.toBase58(),
        amount: "1000000",
        blindingHex: Buffer.from(res.blinding).toString("hex"),
        depositSignature: res.signature
      },
      false
    )

    const storedNotes = await getNotes(SHIELDED_ADDR)
    expect(storedNotes).toHaveLength(1)
    expect(storedNotes[0].pending).toBe(false)

    // Balance reflects the confirmed deposit
    const balances = await shieldedTokenBalances(SHIELDED_ADDR)
    expect(balances[USDC_MINT.toBase58()]).toBe(1_000_000n)
  })

  it("retires prior unconfirmed pending note upon retry, preventing 2x double counting", async () => {
    // 1. First attempt dropped and left a pending note
    await persistReshieldedNote(
      SHIELDED_ADDR,
      {
        assetId: ASSET_ID,
        mint: USDC_MINT.toBase58(),
        amount: "1000000",
        blindingHex: "aa".repeat(32),
        depositSignature: "dropped-sig-old"
      },
      true // pending
    )

    expect(await shieldedTokenBalances(SHIELDED_ADDR)).toEqual({})

    // 2. Recovery / retry runs: retire previous pending notes for this mint
    await retirePendingNotes(SHIELDED_ADDR, USDC_MINT.toBase58())

    // 3. New retry succeeds and is confirmed
    await persistReshieldedNote(
      SHIELDED_ADDR,
      {
        assetId: ASSET_ID,
        mint: USDC_MINT.toBase58(),
        amount: "1000000",
        blindingHex: "bb".repeat(32),
        depositSignature: "confirmed-sig-new"
      },
      false // confirmed
    )

    // Assert: Only 1 note in storage and exactly 1,000,000 balance (NOT 2,000,000)
    const storedNotes = await getNotes(SHIELDED_ADDR)
    expect(storedNotes).toHaveLength(1)
    expect(storedNotes[0].signature).toBe("confirmed-sig-new")
    expect(storedNotes[0].pending).toBe(false)

    const balances = await shieldedTokenBalances(SHIELDED_ADDR)
    expect(balances[USDC_MINT.toBase58()]).toBe(1_000_000n)
  })
})
