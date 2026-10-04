import { describe, expect, it } from "vitest"

import {
  classifyStrand,
  isNativeSolOutput,
  RESUME_GRACE_MS,
  RESUME_MIN_LAMPORTS,
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
    expect(isNativeSolOutput("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(false)
  })
})

describe("token-input classifyStrand (#855)", () => {
  it("resumes token swap when fresh address holds unswapped input token and gas", () => {
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: OLD,
        solLamports: 6_500_000n, // leftover gas SOL
        tokenAmount: 0n,
        inputTokenAmount: 5_000_000n,
        isTokenInput: true
      })
    ).toBe("resume")
  })

  it("leaves token swap unresolved if input token is present but address has no gas", () => {
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: OLD,
        solLamports: 0n,
        tokenAmount: 0n,
        inputTokenAmount: 5_000_000n,
        isTokenInput: true
      })
    ).toBe("unresolved")
  })

  it("never marks token -> SOL as landed when SOL is just leftover gas reserve (#855)", () => {
    // 6.5M lamports leftover gas with 0 input token (e.g. withdraw failed or cancelled)
    // must NOT be mistaken for a landed SOL swap output
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: OLD,
        solLamports: 6_500_000n,
        tokenAmount: 0n,
        inputTokenAmount: 0n,
        isTokenInput: true
      })
    ).toBe("unresolved")
  })

  it("marks token -> SOL as landed when SOL exceeds the gas funding reserve", () => {
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: OLD,
        solLamports: 35_000_000n, // > 9_000_000n gas reserve
        tokenAmount: 0n,
        inputTokenAmount: 0n,
        isTokenInput: true
      })
    ).toBe("landed")
  })

  it("marks token -> token as landed when input token is gone and output token is present", () => {
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: OLD,
        solLamports: 6_500_000n,
        tokenAmount: 250_000_000n, // output token arrived
        inputTokenAmount: 0n,
        isTokenInput: true
      })
    ).toBe("landed")
  })
})

