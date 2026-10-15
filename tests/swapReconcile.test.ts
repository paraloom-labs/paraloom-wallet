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

  it("resumes a token-input swap when withdrawn input tokens sit at the fresh ATA", () => {
    // Even if outputMint is SOL/WSOL or an SPL token, a positive inputTokenAmount
    // means the token withdraw (step 3 of privateSwapFromToken) landed and the
    // Jupiter swap leg never ran.
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: OLD,
        solLamports: 6_933_220n,
        tokenAmount: 0n,
        isTokenInput: true,
        inputTokenAmount: 100_000_000n
      })
    ).toBe("resume")
  })

  it("does not swap gas SOL into outputMint when a token-input swap has no input tokens at the fresh ATA", () => {
    // GAS_LAMPORTS (9M) minus the 0.25% fee and input-mint ATA rent leaves ~6.93M
    // lamports (> RESUME_MIN_LAMPORTS = 6M) at the fresh address. If the token
    // withdraw never settled (inputTokenAmount === 0n), classifyStrand must NOT
    // return "resume" and swap the gas SOL as if it were a SOL-input swap.
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: OLD,
        solLamports: 6_933_220n,
        tokenAmount: 0n,
        isTokenInput: true,
        inputTokenAmount: 0n
      })
    ).toBe("unresolved")
  })

  it("marks a token-input swap landed when input tokens were swapped into output tokens", () => {
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: OLD,
        solLamports: 6_928_000n,
        tokenAmount: 500_000_000n,
        isTokenInput: true,
        inputTokenAmount: 0n
      })
    ).toBe("landed")
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
