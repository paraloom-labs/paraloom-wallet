import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Connection } from "@solana/web3.js"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  assetIdForMint: vi.fn()
}))

import { routeSwap } from "../lib/paraloom/privateSwap"
import { listSwapOutputs, saveSwapOutput } from "../lib/paraloom/swapOutputs"
import { reconcileSwapOutputs } from "../lib/paraloom/swapReconcile"
import {
  classifyStrand,
  isNativeSolOutput,
  RESUME_GRACE_MS,
  RESUME_MIN_LAMPORTS,
  WSOL_MINT
} from "../lib/paraloom/swapReconcileClassify"
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

describe("routeSwap safe integer validation (#127)", () => {
  it("rejects amounts exceeding Number.MAX_SAFE_INTEGER to prevent IEEE-754 precision loss", async () => {
    const tooLarge = BigInt(Number.MAX_SAFE_INTEGER) + 1n
    await expect(
      routeSwap("11111111111111111111111111111111", "SOL", tooLarge)
    ).rejects.toThrow("exceeds JavaScript safe integer limit")
  })
})

describe("reconcileSwapOutputs landed recovery (#127)", () => {
  beforeEach(() => {
    installFakeChrome()
  })

  it("does not attest landed swap if the most recent transaction had an error", async () => {
    const freshAddress = "11111111111111111111111111111111"
    await saveSwapOutput({
      freshAddress,
      freshSecretKeyHex: "00".repeat(64),
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outAmount: 0,
      swapSignature: "",
      createdAt: Date.now() - (RESUME_GRACE_MS + 1000)
    })

    const mockConnection = {
      getBalance: async () => 0,
      getParsedTokenAccountsByOwner: async () => ({
        value: [
          {
            account: {
              data: {
                parsed: {
                  info: {
                    tokenAmount: { amount: "1000000" }
                  }
                }
              }
            }
          }
        ]
      }),
      getSignaturesForAddress: async () => [
        {
          signature: "failed_sig_123",
          err: { InstructionError: [0, "Custom"] }
        }
      ]
    } as unknown as Connection

    const resolved = await reconcileSwapOutputs(mockConnection, "test_shielded")
    expect(resolved).toBe(0)

    const outputs = await listSwapOutputs()
    expect(outputs[0].swapSignature).toBe("")
  })

  it("records landed swap with string outAmount preserving large bigint precision", async () => {
    const freshAddress = "11111111111111111111111111111111"
    const largeAmountStr = "9007199254740993" // > Number.MAX_SAFE_INTEGER
    await saveSwapOutput({
      freshAddress,
      freshSecretKeyHex: "00".repeat(64),
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outAmount: 0,
      swapSignature: "",
      createdAt: Date.now() - (RESUME_GRACE_MS + 1000)
    })

    const mockConnection = {
      getBalance: async () => 0,
      getParsedTokenAccountsByOwner: async () => ({
        value: [
          {
            account: {
              data: {
                parsed: {
                  info: {
                    tokenAmount: { amount: largeAmountStr }
                  }
                }
              }
            }
          }
        ]
      }),
      getSignaturesForAddress: async () => [
        {
          signature: "success_sig_456",
          err: null
        }
      ]
    } as unknown as Connection

    const resolved = await reconcileSwapOutputs(mockConnection, "test_shielded")
    expect(resolved).toBe(1)

    const outputs = await listSwapOutputs()
    expect(outputs[0].swapSignature).toBe("success_sig_456")
    expect(outputs[0].outAmount).toBe(largeAmountStr)
  })
})
