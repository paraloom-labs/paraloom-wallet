// The re-shield recovery pass and the resume path both decide "is this row a
// native SOL output?" with a literal `=== "SOL"` while the rest of the code
// uses `isNativeSolOutput`, which also covers the wrapped mint the swaps app
// actually sends for a SOL output.
//
// Consequence: a SOL round trip persists its row with `outputMint` =
// `So111...112`, both guards treat it as a token, `reshieldToken` is called with
// the literal-invalid mint, `new PublicKey("SOL")`-style parsing is skipped but
// the WSOL ATA the unwrapped lamports never funded is read and comes back empty
// — so the re-shield silently does nothing and the funds sit at a fresh address.
//
// These cases pin the classification the guards depend on, and the fact that the
// native deposit path (not the token one) is the right branch for both
// spellings.
import { classifyStrand, isNativeSolOutput, WSOL_MINT } from "~lib/paraloom/swapReconcileClassify"
import { describe, expect, it } from "vitest"

const SOL_LITERAL = "SOL"
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

describe("native SOL is one asset with two wire spellings", () => {
  it.each([
    ["the literal", SOL_LITERAL],
    ["the wrapped mint", WSOL_MINT]
  ])("recognises %s as native", (_label, mint) => {
    expect(isNativeSolOutput(mint)).toBe(true)
    // The literal predicate the two guards used disagrees for the wrapped mint:
    // `WSOL_MINT !== "SOL"`, so it says "token".
    expect(mint !== SOL_LITERAL).toBe(mint === WSOL_MINT)
  })

  it("keeps a real token distinguishable", () => {
    expect(isNativeSolOutput(USDC)).toBe(false)
    expect(USDC as string !== SOL_LITERAL).toBe(true)
  })

  it("is a well-formed base58 mint, which is why the literal path fails quietly", () => {
    // `new PublicKey(WSOL_MINT)` succeeds, so nothing throws — the round trip is
    // simply dropped against an empty WSOL ATA.
    expect(WSOL_MINT).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)
  })
})

describe("a native output is recorded as landed, never resumed as swappable SOL", () => {
  // Mirrors the real values: the reconciler reclassifies a resume on a native
  // output to "landed" precisely because the SOL there is the OUTPUT.
  const stranded = { hasSignature: false, ageMs: 200_000, solLamports: 9_000_000n, tokenAmount: 0n }

  it("classifies a funded fresh address as a resume before the native correction", () => {
    expect(classifyStrand(stranded)).toBe("resume")
  })

  it.each([
    ["the literal", SOL_LITERAL],
    ["the wrapped mint", WSOL_MINT]
  ])("lands it instead for %s", (_label, mint) => {
    // The correction in reconcileSwapOutputs, applied to both spellings.
    const action = classifyStrand(stranded) === "resume" && isNativeSolOutput(mint) ? "landed" : classifyStrand(stranded)
    expect(action).toBe("landed")
  })

  it("still resumes a real token output", () => {
    const action =
      classifyStrand(stranded) === "resume" && isNativeSolOutput(USDC) ? "landed" : classifyStrand(stranded)
    expect(action).toBe("resume")
  })
})
