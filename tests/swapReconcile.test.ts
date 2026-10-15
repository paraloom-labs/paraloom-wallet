import { describe, expect, it } from "vitest"

import {
  classifyStrand,
  effectiveSwapReshield,
  isNativeSolOutput,
  RESUME_GRACE_MS,
  RESUME_MIN_LAMPORTS,
  swapInputInfo,
  swapTokenLabel,
  USDC_MINT,
  WSOL_MINT
} from "../lib/paraloom/swapReconcileClassify"

const OLD = RESUME_GRACE_MS + 1

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
    expect(isNativeSolOutput(USDC_MINT)).toBe(false)
  })
})

describe("swapTokenLabel & swapInputInfo", () => {
  it("renders both 'SOL' and WSOL_MINT as SOL instead of So11…1112", () => {
    expect(swapTokenLabel("SOL")).toBe("SOL")
    expect(swapTokenLabel(WSOL_MINT)).toBe("SOL")
    expect(swapTokenLabel(USDC_MINT)).toBe("USDC")
  })

  it("treats undefined, 'SOL', and WSOL_MINT as 9-decimal SOL inputs", () => {
    expect(swapInputInfo(undefined)).toEqual({ decimals: 9, symbol: "SOL" })
    expect(swapInputInfo("SOL")).toEqual({ decimals: 9, symbol: "SOL" })
    expect(swapInputInfo(WSOL_MINT)).toEqual({ decimals: 9, symbol: "SOL" })
    expect(swapInputInfo(USDC_MINT)).toEqual({ decimals: 6, symbol: "USDC" })
  })
})

describe("effectiveSwapReshield", () => {
  it("defaults token-input swaps (e.g. USDC -> WSOL) to reshield=true when omitted", () => {
    expect(
      effectiveSwapReshield({ inputMint: USDC_MINT, outputMint: WSOL_MINT })
    ).toBe(true)
    expect(
      effectiveSwapReshield({
        inputMint: USDC_MINT,
        outputMint: WSOL_MINT,
        reshield: false
      })
    ).toBe(false)
  })

  it("defaults native-SOL input swaps to reshield=false and never reshields a SOL output", () => {
    expect(effectiveSwapReshield({ outputMint: USDC_MINT })).toBe(false)
    expect(
      effectiveSwapReshield({ outputMint: USDC_MINT, reshield: true })
    ).toBe(true)
    expect(
      effectiveSwapReshield({ outputMint: WSOL_MINT, reshield: true })
    ).toBe(false)
    expect(
      effectiveSwapReshield({
        inputMint: WSOL_MINT,
        outputMint: USDC_MINT
      })
    ).toBe(false)
  })
})
