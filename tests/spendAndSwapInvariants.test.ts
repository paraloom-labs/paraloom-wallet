import { Connection, PublicKey } from "@solana/web3.js"
import { type ShieldedNote } from "~lib/paraloom/notes"
import { privateSwapFromToken } from "~lib/paraloom/privateSwap"
import { spendV3 } from "~lib/paraloom/transactFlow"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { installFakeChrome } from "./support/chromeStorage"

const { assetIdForMint, fakeAssetIdForMint, NATIVE_ASSET_HEX } = vi.hoisted(() => {
  const fakeAssetIdForMint = (mintHex: string) =>
    (mintHex.trim().toLowerCase().match(/../g) ?? [])
      .map((b) => (parseInt(b, 16) ^ 0x5a).toString(16).padStart(2, "0"))
      .join("")

  return {
    NATIVE_ASSET_HEX: "00".repeat(32),
    fakeAssetIdForMint,
    assetIdForMint: vi.fn(async (mintHex: string) => fakeAssetIdForMint(mintHex)),
    proveTransact: vi.fn(),
    v3MerklePath: vi.fn(),
    v3NoteCommitment: vi.fn(),
    v3NoteCommitmentAsset: vi.fn(),
    v3NotePubkey: vi.fn()
  }
})

vi.mock("~lib/prover", () => ({
  assetIdForMint,
  NATIVE_ASSET_HEX,
  proveTransact: vi.fn(),
  v3MerklePath: vi.fn(),
  v3NoteCommitment: vi.fn(),
  v3NoteCommitmentAsset: vi.fn(),
  v3NotePubkey: vi.fn()
}))

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const USDC_HEX = Buffer.from(new PublicKey(USDC_MINT).toBytes()).toString("hex")
const USDC_ASSET = fakeAssetIdForMint(USDC_HEX)

const OTHER_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
const OTHER_HEX = Buffer.from(new PublicKey(OTHER_MINT).toBytes()).toString("hex")
const OTHER_ASSET = fakeAssetIdForMint(OTHER_HEX)

function splNote(amount: bigint, mint?: string, assetId = USDC_ASSET): ShieldedNote {
  return {
    amount: amount.toString(),
    blinding: "aa".repeat(32),
    assetId,
    mint,
    signature: "",
    createdAt: 1,
    spent: false,
    commitment: "cc".repeat(32)
  }
}

function nativeNote(amount: bigint, mint?: string): ShieldedNote {
  return {
    amount: amount.toString(),
    blinding: "bb".repeat(32),
    assetId: NATIVE_ASSET_HEX,
    mint,
    signature: "sig1",
    createdAt: 1,
    spent: false
  }
}

const DUMMY_CONN = {} as Connection
const SHIELDED_ADDR = "paraloom1" + "11".repeat(64)
const SPEND_PRIVKEY = "aa".repeat(32)
const OWN_BOX_PUB = "bb".repeat(32)

beforeEach(() => {
  installFakeChrome()
})

describe("spendV3 pre-spend mint <-> assetId invariants", () => {
  it("rejects native SOL note carrying a mint", async () => {
    const note = nativeNote(10_000_000n, USDC_MINT)
    await expect(
      spendV3(DUMMY_CONN, SHIELDED_ADDR, SPEND_PRIVKEY, OWN_BOX_PUB, [note], 5_000_000n, {
        kind: "withdraw",
        recipientSolanaHex: "11".repeat(32)
      })
    ).rejects.toThrow("native SOL notes cannot carry a mint")
  })

  it("rejects an SPL note missing a mint", async () => {
    const note = splNote(100n, undefined)
    await expect(
      spendV3(DUMMY_CONN, SHIELDED_ADDR, SPEND_PRIVKEY, OWN_BOX_PUB, [note], 50n, {
        kind: "withdraw",
        recipientSolanaHex: "11".repeat(32)
      })
    ).rejects.toThrow("a shielded SPL note must carry its mint to be spent")
  })

  it("rejects SPL inputs with mismatched mints", async () => {
    const n1 = splNote(50n, USDC_MINT, USDC_ASSET)
    const n2 = splNote(50n, OTHER_MINT, USDC_ASSET)
    await expect(
      spendV3(DUMMY_CONN, SHIELDED_ADDR, SPEND_PRIVKEY, OWN_BOX_PUB, [n1, n2], 80n, {
        kind: "withdraw",
        recipientSolanaHex: "11".repeat(32)
      })
    ).rejects.toThrow("all spent SPL notes must share one mint")
  })

  it("rejects an SPL note carrying an invalid base58 mint", async () => {
    const note = splNote(100n, "not-a-valid-base58-key!!!", USDC_ASSET)
    await expect(
      spendV3(DUMMY_CONN, SHIELDED_ADDR, SPEND_PRIVKEY, OWN_BOX_PUB, [note], 50n, {
        kind: "withdraw",
        recipientSolanaHex: "11".repeat(32)
      })
    ).rejects.toThrow("invalid SPL mint on note")
  })

  it("rejects an SPL note whose mint does not match assetIdHex", async () => {
    // Note claims USDC assetId, but carries OTHER_MINT
    const note = splNote(100n, OTHER_MINT, USDC_ASSET)
    await expect(
      spendV3(DUMMY_CONN, SHIELDED_ADDR, SPEND_PRIVKEY, OWN_BOX_PUB, [note], 50n, {
        kind: "withdraw",
        recipientSolanaHex: "11".repeat(32)
      })
    ).rejects.toThrow("spent SPL note mint does not match assetId")
  })
})

describe("privateSwapFromToken pre-gas validation", () => {
  it("rejects invalid amount", async () => {
    await expect(
      privateSwapFromToken(
        DUMMY_CONN,
        SHIELDED_ADDR,
        SPEND_PRIVKEY,
        OWN_BOX_PUB,
        [splNote(100n, USDC_MINT)],
        [nativeNote(10_000_000n)],
        { inputMint: USDC_MINT, amountTokenUnits: 0n, outputMint: "SOL" }
      )
    ).rejects.toThrow("amount must be > 0")
  })

  it("rejects empty token inputs", async () => {
    await expect(
      privateSwapFromToken(
        DUMMY_CONN,
        SHIELDED_ADDR,
        SPEND_PRIVKEY,
        OWN_BOX_PUB,
        [],
        [nativeNote(10_000_000n)],
        { inputMint: USDC_MINT, amountTokenUnits: 50n, outputMint: "SOL" }
      )
    ).rejects.toThrow("transact spends 1 or 2 notes")
  })

  it("rejects token inputs with insufficient sum", async () => {
    await expect(
      privateSwapFromToken(
        DUMMY_CONN,
        SHIELDED_ADDR,
        SPEND_PRIVKEY,
        OWN_BOX_PUB,
        [splNote(40n, USDC_MINT)],
        [nativeNote(10_000_000n)],
        { inputMint: USDC_MINT, amountTokenUnits: 50n, outputMint: "SOL" }
      )
    ).rejects.toThrow("amount exceeds the selected notes")
  })

  it("rejects token inputs carrying a poisoned mint before spending gas", async () => {
    // Poisoned note: assetId matches USDC, but mint was corrupted to system program
    const poisoned = splNote(100n, "11111111111111111111111111111111", USDC_ASSET)
    await expect(
      privateSwapFromToken(
        DUMMY_CONN,
        SHIELDED_ADDR,
        SPEND_PRIVKEY,
        OWN_BOX_PUB,
        [poisoned],
        [nativeNote(10_000_000n)],
        { inputMint: USDC_MINT, amountTokenUnits: 50n, outputMint: "SOL" }
      )
    ).rejects.toThrow("token inputs must match the swap input mint and assetId")
  })

  it("rejects gas inputs carrying a mint", async () => {
    const taintedGas = nativeNote(10_000_000n, USDC_MINT)
    await expect(
      privateSwapFromToken(
        DUMMY_CONN,
        SHIELDED_ADDR,
        SPEND_PRIVKEY,
        OWN_BOX_PUB,
        [splNote(100n, USDC_MINT)],
        [taintedGas],
        { inputMint: USDC_MINT, amountTokenUnits: 50n, outputMint: "SOL" }
      )
    ).rejects.toThrow("gas inputs must be native SOL notes without a mint")
  })
})
