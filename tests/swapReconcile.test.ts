import { describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  assetIdForMint: async () => "00".repeat(32),
  v3NotePubkey: async () => "00".repeat(32)
}))

import {
  classifyStrand,
  isNativeSolOutput,
  RESUME_GRACE_MS,
  RESUME_MIN_LAMPORTS,
  WSOL_MINT
} from "../lib/paraloom/swapReconcileClassify"
import { routeSwap } from "../lib/paraloom/privateSwap"
import { reconcileSwapOutputs } from "../lib/paraloom/swapReconcile"
import { saveSwapOutput, listSwapOutputs, type SwapOutput } from "../lib/paraloom/swapOutputs"
import { installFakeChrome } from "./support/chromeStorage"

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

describe("reconcileSwapOutputs & routeSwap safe integer bounds (#127)", () => {
  it("rejects swap amounts exceeding Number.MAX_SAFE_INTEGER before making network requests", async () => {
    const tooLarge = BigInt(Number.MAX_SAFE_INTEGER) + 1n
    await expect(
      routeSwap("11111111111111111111111111111111", "SOL", tooLarge)
    ).rejects.toThrow("exceeds JavaScript safe integer limit")
  })

  it("does not attest landed swaps when the transaction has err != null", async () => {
    installFakeChrome()
    const freshAddress = "11111111111111111111111111111111"
    const swap: SwapOutput = {
      freshAddress,
      freshSecretKeyHex: "00".repeat(64),
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outAmount: 0,
      swapSignature: "",
      createdAt: Date.now() - (RESUME_GRACE_MS + 1000)
    }
    await saveSwapOutput(swap)

    const fakeConnection = {
      getBalance: async () => 0,
      getParsedTokenAccountsByOwner: async () => ({
        value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: "500000" } } } } } }]
      }),
      getSignaturesForAddress: async () => [
        { signature: "failed_tx_sig", err: { InstructionError: [0, "Custom"] } }
      ]
    } as any

    const resolved = await reconcileSwapOutputs(fakeConnection, "shielded-addr")
    expect(resolved).toBe(0)
    const outputs = await listSwapOutputs()
    expect(outputs[0].swapSignature).toBe("")
  })
})
