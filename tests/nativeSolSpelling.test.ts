import { describe, expect, it } from "vitest"

import {
  isNativeSolOutput,
  WSOL_MINT
} from "../lib/paraloom/swapReconcileClassify"
import {
  classifyStrand,
  RESUME_GRACE_MS,
  RESUME_MIN_LAMPORTS
} from "../lib/paraloom/swapReconcileClassify"

const OLD = RESUME_GRACE_MS + 1
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

describe("nativeSolSpelling and WSOL output handling (#211)", () => {
  it("recognizes both 'SOL' and WSOL_MINT as native SOL output", () => {
    expect(isNativeSolOutput("SOL")).toBe(true)
    expect(isNativeSolOutput(WSOL_MINT)).toBe(true)
    expect(isNativeSolOutput(USDC_MINT)).toBe(false)
  })

  it("differentiates literal 'SOL' check vs isNativeSolOutput for WSOL", () => {
    // Demonstrates the defect: literal comparison failed for WSOL_MINT
    expect(WSOL_MINT === "SOL").toBe(false)
    expect(isNativeSolOutput(WSOL_MINT)).toBe(true)
  })

  it("skips native SOL in SPL reshield recovery guard regardless of wire spelling", () => {
    const isSplRecoveryEligible = (o: { reshield: boolean; swapSignature?: string; outputMint: string }) => {
      if (!o.reshield || !o.swapSignature || isNativeSolOutput(o.outputMint)) return false
      return true
    }

    expect(isSplRecoveryEligible({ reshield: true, swapSignature: "sig1", outputMint: "SOL" })).toBe(false)
    expect(isSplRecoveryEligible({ reshield: true, swapSignature: "sig2", outputMint: WSOL_MINT })).toBe(false)
    expect(isSplRecoveryEligible({ reshield: true, swapSignature: "sig3", outputMint: USDC_MINT })).toBe(true)
  })

  it("correctly reconciles stranded SOL outputs to landed status", () => {
    // When fresh address holds funded SOL, classifyStrand produces 'resume'
    const action = classifyStrand({
      hasSignature: false,
      ageMs: OLD,
      solLamports: RESUME_MIN_LAMPORTS + 10_000_000n,
      tokenAmount: 0n
    })
    expect(action).toBe("resume")

    // Both 'SOL' and WSOL_MINT outputs must map resume -> landed to prevent SOL -> SOL loops
    const reconcileAction = (rawAction: string, mint: string) => {
      if (rawAction === "resume" && isNativeSolOutput(mint)) {
        return "landed"
      }
      return rawAction
    }

    expect(reconcileAction(action, "SOL")).toBe("landed")
    expect(reconcileAction(action, WSOL_MINT)).toBe("landed")
    expect(reconcileAction(action, USDC_MINT)).toBe("resume")
  })
})
