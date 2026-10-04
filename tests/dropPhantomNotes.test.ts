import { beforeEach, describe, expect, it, vi } from "vitest"
import { dropPhantomNotes } from "../lib/paraloom/dropPhantomNotes"
import { addDiscoveredNote, getNotes, type ShieldedNote } from "~lib/paraloom/notes"
import { installFakeChrome } from "./support/chromeStorage"

vi.mock("~lib/prover", () => ({ NATIVE_ASSET_HEX: "00".repeat(32) }))

const ACCOUNT = "paraloom1" + "33".repeat(64)
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const USDC_ASSET = "aa".repeat(32)

beforeEach(() => {
  installFakeChrome()
})

describe("dropPhantomNotes for SPL token notes (#857)", () => {
  it("drops phantom SPL token notes that never landed on-chain past the grace period", async () => {
    const oldTime = Date.now() - 150_000 // 150s ago (exceeds 120s grace period)
    const phantomCommitment = "phantom_spl_commitment_" + "11".repeat(20)
    const validCommitment = "valid_spl_commitment_" + "22".repeat(20)

    const phantomSplNote: ShieldedNote = {
      amount: "50000000",
      blinding: "11".repeat(32),
      assetId: USDC_ASSET,
      mint: USDC_MINT,
      signature: "",
      createdAt: oldTime,
      spent: false,
      commitment: phantomCommitment
    }

    const validSplNote: ShieldedNote = {
      amount: "100000000",
      blinding: "22".repeat(32),
      assetId: USDC_ASSET,
      mint: USDC_MINT,
      signature: "",
      createdAt: oldTime,
      spent: false,
      commitment: validCommitment
    }

    await addDiscoveredNote(ACCOUNT, phantomSplNote)
    await addDiscoveredNote(ACCOUNT, validSplNote)

    // On-chain tree only contains the valid commitment
    const cachedLeaves = [{ commitmentHex: validCommitment }]

    const result = await dropPhantomNotes(
      {} as any,
      ACCOUNT,
      [phantomSplNote, validSplNote],
      cachedLeaves
    )

    // The phantom SPL note must be dropped from candidates
    expect(result).toHaveLength(1)
    expect(result[0].commitment).toBe(validCommitment)

    // And marked spent in storage so it won't be picked again
    const storedNotes = await getNotes(ACCOUNT)
    const storedPhantom = storedNotes.find((n) => n.commitment === phantomCommitment)
    expect(storedPhantom?.spent).toBe(true)
  })

  it("does not drop fresh SPL notes that are still within the grace window", async () => {
    const recentTime = Date.now() - 30_000 // 30s ago (within 120s grace)
    const recentCommitment = "recent_commitment_" + "33".repeat(20)

    const freshSplNote: ShieldedNote = {
      amount: "25000000",
      blinding: "33".repeat(32),
      assetId: USDC_ASSET,
      mint: USDC_MINT,
      signature: "",
      createdAt: recentTime,
      spent: false,
      commitment: recentCommitment
    }

    const result = await dropPhantomNotes(
      {} as any,
      ACCOUNT,
      [freshSplNote],
      [] // empty tree, but note is fresh
    )

    expect(result).toHaveLength(1)
    expect(result[0].commitment).toBe(recentCommitment)
  })

  it("preserves deposit notes which already have a verified leafIndex", async () => {
    const oldTime = Date.now() - 200_000
    const depositNote: ShieldedNote = {
      amount: "1000000",
      blinding: "44".repeat(32),
      assetId: USDC_ASSET,
      mint: USDC_MINT,
      signature: "tx_deposit_sig",
      createdAt: oldTime,
      spent: false,
      leafIndex: 42
    }

    const result = await dropPhantomNotes({} as any, ACCOUNT, [depositNote], [])
    expect(result).toHaveLength(1)
    expect(result[0].leafIndex).toBe(42)
  })
})
