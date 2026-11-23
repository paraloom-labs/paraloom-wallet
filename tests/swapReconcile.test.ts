import { describe, expect, it, vi } from "vitest"
import { Keypair, type Connection } from "@solana/web3.js"

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

describe("token-input strands in classifyStrand & reconcileSwapOutputs", () => {
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

  it("resumes a Token -> SOL strand when withdrawn input SPL tokens still sit in the fresh ATA", () => {
    // 0.00696 SOL remaining gas (> RESUME_MIN_LAMPORTS) + 10 USDC waiting to swap -> must resume, NOT mark landed!
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: OLD,
        solLamports: 6_960_000n,
        tokenAmount: 0n,
        inputTokenAmount: 10_000_000n,
        isNativeOutput: true
      })
    ).toBe("resume")

    // Even when gas SOL dipped <= RESUME_MIN_LAMPORTS (e.g. 4M lamports left after rent/fees), still resume!
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: OLD,
        solLamports: 4_000_000n,
        tokenAmount: 0n,
        inputTokenAmount: 10_000_000n,
        isNativeOutput: true
      })
    ).toBe("resume")
  })

  it("marks Token -> SOL as landed once the input SPL tokens are gone and SOL remains", () => {
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: OLD,
        solLamports: 25_000_000n,
        tokenAmount: 0n,
        inputTokenAmount: 0n,
        isNativeOutput: true
      })
    ).toBe("landed")
  })

  it("resumes a Token A -> SOL stranded SwapOutput with its persisted inputMint via reconcileSwapOutputs", async () => {
    vi.resetModules()
    const storage: Record<string, unknown> = {}
    ;(globalThis as { chrome?: unknown }).chrome = {
      storage: {
        local: {
          get: async (k: string) => ({ [k]: storage[k] }),
          set: async (obj: Record<string, unknown>) => Object.assign(storage, obj)
        }
      }
    }

    const resumeMock = vi.fn().mockResolvedValue({
      swapSignature: "sigResumedTokenSwap",
      outAmount: 42_000_000
    })

    vi.doMock("~lib/prover", () => ({
      NATIVE_ASSET_HEX: "00".repeat(32),
      assetIdForMint: async () => "aa".repeat(32)
    }))
    vi.doMock("../lib/paraloom/privateSwap", () => ({
      isNativeSolOutput,
      resumeSwapAtFreshAddress: resumeMock
    }))

    const { saveSwapOutput, listSwapOutputs } = await import("../lib/paraloom/swapOutputs")
    const { reconcileSwapOutputs } = await import("../lib/paraloom/swapReconcile")

    const fresh = Keypair.generate()
    await saveSwapOutput({
      freshAddress: fresh.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(fresh.secretKey).toString("hex"),
      inputMint: USDC_MINT,
      outputMint: WSOL_MINT,
      outAmount: 0,
      swapSignature: "",
      reshield: true,
      createdAt: Date.now() - OLD
    })

    const fakeConn = {
      getBalance: async () => 6_960_000,
      getParsedTokenAccountsByOwner: async () => ({
        value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: "5000000" } } } } } }]
      })
    } as unknown as Connection

    const resolved = await reconcileSwapOutputs(fakeConn, "paraloom1" + "11".repeat(32))
    expect(resolved).toBe(1)
    expect(resumeMock).toHaveBeenCalledTimes(1)
    expect(resumeMock.mock.calls[0][6]).toBe(USDC_MINT)

    const updated = await listSwapOutputs()
    expect(updated[0].swapSignature).toBe("sigResumedTokenSwap")
    expect(updated[0].outAmount).toBe(42_000_000)

    vi.doUnmock("../lib/paraloom/privateSwap")
    vi.doUnmock("~lib/prover")
  })
})
