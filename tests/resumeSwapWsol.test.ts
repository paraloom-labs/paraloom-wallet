// Reproducer for the WSOL re-shield bug in resumeSwapAtFreshAddress.
//
// privateSwapSolToToken correctly routes a WSOL (wrapped-SOL) output through
// the native-SOL deposit path (depositV3), but resumeSwapAtFreshAddress only
// checks `outputMint !== "SOL"` — it misses the WSOL mint
// (So11111111111111111111111111111111111111112), so a resumed swap with WSOL
// output incorrectly falls into the SPL reshieldToken() path instead of the
// native deposit path. This causes the reshield to either fail (no WSOL token
// account exists after Jupiter unwraps it) or produce a mistyped shielded note.
//
// The fix is to use `isNativeSolOutput(outputMint)` consistently, the same
// helper the primary swap flow uses.

import { describe, expect, it } from "vitest"

import { isNativeSolOutput, WSOL_MINT } from "../lib/paraloom/swapReconcileClassify"

// Simulates the guard condition in resumeSwapAtFreshAddress BEFORE the fix.
// This is the buggy logic: only checks for literal "SOL".
function shouldReshieldAsTokenBuggy(reshield: boolean, outputMint: string): boolean {
  return reshield && outputMint !== "SOL"
}

// Simulates the guard condition AFTER the fix: uses isNativeSolOutput, matching
// the primary swap flow in privateSwapSolToToken.
function shouldReshieldAsTokenFixed(reshield: boolean, outputMint: string): boolean {
  return reshield && !isNativeSolOutput(outputMint)
}

describe("resumeSwapAtFreshAddress WSOL re-shield bug", () => {
  it("BUG: buggy guard treats WSOL mint as a token, not native SOL", () => {
    // The WSOL mint is NOT the literal "SOL", so the buggy check sends it to
    // the SPL reshieldToken() path — WRONG.
    expect(shouldReshieldAsTokenBuggy(true, WSOL_MINT)).toBe(true)
    // This ^^^ is the bug: it should be false (WSOL is native SOL after unwrap).
  })

  it("FIX: fixed guard correctly recognizes WSOL as native SOL", () => {
    // After the fix, WSOL is treated as native SOL and skips the token path.
    expect(shouldReshieldAsTokenFixed(true, WSOL_MINT)).toBe(false)
  })

  it("FIX: literal 'SOL' is still correctly treated as native", () => {
    expect(shouldReshieldAsTokenFixed(true, "SOL")).toBe(false)
  })

  it("FIX: a real SPL mint (e.g. USDC) still goes through the token path", () => {
    const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    expect(shouldReshieldAsTokenFixed(true, USDC_MINT)).toBe(true)
  })

  it("FIX: no reshield requested → neither path fires", () => {
    expect(shouldReshieldAsTokenFixed(false, WSOL_MINT)).toBe(false)
    expect(shouldReshieldAsTokenFixed(false, "SOL")).toBe(false)
    expect(shouldReshieldAsTokenFixed(false, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(false)
  })
})
