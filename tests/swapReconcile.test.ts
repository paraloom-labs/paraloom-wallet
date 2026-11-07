import { beforeEach, describe, expect, it } from "vitest"

import {
  dismissSwapOutput,
  listSwapOutputs,
  saveSwapOutput
} from "../lib/paraloom/swapOutputs"
import {
  classifyStrand,
  isNativeSolOutput,
  RESUME_GRACE_MS,
  RESUME_MIN_LAMPORTS,
  WSOL_MINT
} from "../lib/paraloom/swapReconcileClassify"
import { installFakeChrome } from "./support/chromeStorage"

const OLD = RESUME_GRACE_MS + 1

beforeEach(() => {
  installFakeChrome()
})

describe("classifyStrand", () => {
  it("skips a row that already has a signature (done)", () => {
    expect(
      classifyStrand({
        hasSignature: true,
        ageMs: OLD,
        solLamports: 10_000_000n,
        tokenAmount: 0n
      })
    ).toBe("skip")
  })

  it("skips a row still inside the in-flight grace window", () => {
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: RESUME_GRACE_MS - 1,
        solLamports: 10_000_000n,
        tokenAmount: 5_000_000n
      })
    ).toBe("skip")
  })

  it("resumes when the fresh address still holds swappable SOL", () => {
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: OLD,
        solLamports: RESUME_MIN_LAMPORTS + 1n,
        tokenAmount: 0n
      })
    ).toBe("resume")
  })

  it("marks landed when SOL is gone but the bought token sits at the address", () => {
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: OLD,
        solLamports: RESUME_MIN_LAMPORTS,
        tokenAmount: 597_800n
      })
    ).toBe("landed")
  })

  it("leaves a strand unresolved when nothing is recoverable on-chain", () => {
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: OLD,
        solLamports: 0n,
        tokenAmount: 0n
      })
    ).toBe("unresolved")
  })

  it("prefers resume over landed when both SOL and token are present", () => {
    // A partially-funded address that also holds dust token: finishing the swap
    // of the remaining SOL is the correct move, not treating it as already done.
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: OLD,
        solLamports: RESUME_MIN_LAMPORTS + 1n,
        tokenAmount: 100n
      })
    ).toBe("resume")
  })

  it("does not resume on exactly the reserve threshold (nothing left to swap)", () => {
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: OLD,
        solLamports: RESUME_MIN_LAMPORTS,
        tokenAmount: 0n
      })
    ).toBe("unresolved")
  })
})

describe("isNativeSolOutput", () => {
  it("treats the wrapped-SOL mint as native SOL (the app sends this, not 'SOL')", () => {
    expect(isNativeSolOutput(WSOL_MINT)).toBe(true)
  })

  it("treats the literal 'SOL' as native SOL", () => {
    expect(isNativeSolOutput("SOL")).toBe(true)
  })

  it("treats USDC (any SPL mint) as NOT native SOL", () => {
    expect(isNativeSolOutput("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(false)
  })

  it("handles whitespace-padded SOL and WSOL mint strings", () => {
    expect(isNativeSolOutput(" SOL ")).toBe(true)
    expect(isNativeSolOutput(` ${WSOL_MINT} `)).toBe(true)
  })
})

describe("classifyStrand NaN ageMs and swapOutputs upsert invariants (#264)", () => {
  it("skips a row whose ageMs is NaN or non-finite instead of bypassing RESUME_GRACE_MS", () => {
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: Number.NaN,
        solLamports: RESUME_MIN_LAMPORTS + 100n,
        tokenAmount: 500n
      })
    ).toBe("skip")
  })

  it("preserves original createdAt, reshield, and secretKey on upsert and guards non-array storage", async () => {
    await chrome.storage.local.set({ paraloom_swap_outputs: { corrupted: true } })
    expect(await listSwapOutputs()).toEqual([])

    await saveSwapOutput({
      freshAddress: "FreshAddr11111111111111111111111111111111111",
      freshSecretKeyHex: "aa".repeat(64),
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outAmount: 0,
      swapSignature: "",
      reshield: true,
      createdAt: 1000
    })

    // Second-stage update passes a later createdAt and omits reshield
    await saveSwapOutput({
      freshAddress: "FreshAddr11111111111111111111111111111111111",
      freshSecretKeyHex: "",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outAmount: 250000,
      swapSignature: "sig-landed",
      createdAt: 9999
    })

    const rows = await listSwapOutputs()
    expect(rows).toHaveLength(1)
    expect(rows[0].createdAt).toBe(1000)
    expect(rows[0].reshield).toBe(true)
    expect(rows[0].freshSecretKeyHex).toBe("aa".repeat(64))
    expect(rows[0].outAmount).toBe(250000)
    expect(rows[0].swapSignature).toBe("sig-landed")

    await expect(
      saveSwapOutput({
        freshAddress: "",
        freshSecretKeyHex: "bb".repeat(64),
        outputMint: "SOL",
        outAmount: 0,
        swapSignature: "",
        createdAt: 1000
      })
    ).rejects.toThrow(/freshAddress/)

    await dismissSwapOutput("FreshAddr11111111111111111111111111111111111")
    expect(await listSwapOutputs()).toEqual([])
  })
})
