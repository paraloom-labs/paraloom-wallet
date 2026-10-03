import { Keypair, PublicKey, type Connection } from "@solana/web3.js"
import { beforeEach, describe, expect, it, vi } from "vitest"

import * as privateSwap from "../lib/paraloom/privateSwap"
import { listSwapOutputs, saveSwapOutput, type SwapOutput } from "../lib/paraloom/swapOutputs"
import { reconcileSwapOutputs } from "../lib/paraloom/swapReconcile"
import {
  classifyStrand,
  isNativeSolOutput,
  isTokenInput,
  RESUME_GRACE_MS,
  RESUME_MIN_LAMPORTS,
  WSOL_MINT
} from "../lib/paraloom/swapReconcileClassify"
import { installFakeChrome } from "./support/chromeStorage"

// privateSwap reaches ~lib/prover and the wasm module cannot load under vitest.
vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  assetIdForMint: vi.fn(async () => "00".repeat(32))
}))

const OLD = RESUME_GRACE_MS + 1
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"

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

  describe("with isTokenInput", () => {
    it("returns 'resume' when fresh address has input tokens, regardless of leftover gas SOL", () => {
      expect(
        classifyStrand({
          hasSignature: false,
          ageMs: OLD,
          solLamports: 6_500_000n, // leftover gas SOL > RESUME_MIN_LAMPORTS
          tokenAmount: 0n,
          isTokenInput: true,
          inputTokenAmount: 5_000_000n
        })
      ).toBe("resume")
    })

    it("returns 'landed' when input tokens are spent and output tokens sit at the fresh address", () => {
      expect(
        classifyStrand({
          hasSignature: false,
          ageMs: OLD,
          solLamports: 6_500_000n,
          tokenAmount: 2_000_000n,
          isTokenInput: true,
          inputTokenAmount: 0n
        })
      ).toBe("landed")
    })

    it("returns 'unresolved' when neither input nor output tokens are present, ignoring leftover gas SOL", () => {
      // Leftover gas SOL must not trigger resume or landed for a token input
      expect(
        classifyStrand({
          hasSignature: false,
          ageMs: OLD,
          solLamports: 6_500_000n,
          tokenAmount: 0n,
          isTokenInput: true,
          inputTokenAmount: 0n
        })
      ).toBe("unresolved")
    })
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

describe("isTokenInput", () => {
  it("identifies SPL tokens as token inputs", () => {
    expect(isTokenInput(USDC_MINT)).toBe(true)
    expect(isTokenInput(BONK_MINT)).toBe(true)
  })

  it("identifies SOL and WSOL as not token inputs", () => {
    expect(isTokenInput("SOL")).toBe(false)
    expect(isTokenInput(WSOL_MINT)).toBe(false)
  })

  it("identifies undefined or empty string as not token inputs", () => {
    expect(isTokenInput(undefined)).toBe(false)
    expect(isTokenInput("")).toBe(false)
  })
})

describe("reconcileSwapOutputs regression (paraloom-core#855)", () => {
  beforeEach(() => {
    installFakeChrome()
    vi.restoreAllMocks()
  })

  function makeMockConnection(opts: {
    solLamports?: bigint
    tokenAccounts?: Record<string, bigint>
    signatures?: string[]
  }) {
    return {
      getBalance: async () => opts.solLamports ?? 0n,
      getParsedTokenAccountsByOwner: async (_owner: PublicKey, filter: { mint: PublicKey }) => {
        const mintStr = filter.mint.toBase58()
        const amt = opts.tokenAccounts?.[mintStr] ?? 0n
        if (amt === 0n) return { value: [] }
        return {
          value: [
            {
              account: {
                data: {
                  parsed: {
                    info: {
                      tokenAmount: { amount: amt.toString() }
                    }
                  }
                }
              }
            }
          ]
        }
      },
      getSignaturesForAddress: async () => {
        return (opts.signatures ?? []).map((sig) => ({ signature: sig }))
      }
    } as unknown as Connection
  }

  it("Case 1 (token -> SOL): does NOT mistake leftover gas SOL for completion and leaves pending if resume cannot complete", async () => {
    const fresh = Keypair.generate()
    const swapRow: SwapOutput = {
      freshAddress: fresh.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(fresh.secretKey).toString("hex"),
      inputMint: USDC_MINT,
      inputAmount: "5000000",
      outputMint: WSOL_MINT,
      outAmount: 0,
      swapSignature: "",
      createdAt: Date.now() - OLD
    }
    await saveSwapOutput(swapRow)

    const conn = makeMockConnection({
      solLamports: 6_500_000n, // leftover gas SOL
      tokenAccounts: {
        [USDC_MINT]: 5_000_000n // unswapped input token in ATA
      },
      signatures: ["gas_funding_tx_sig"]
    })

    // Mock resumeTokenSwapAtFreshAddress failing (e.g. offline router)
    vi.spyOn(privateSwap, "resumeTokenSwapAtFreshAddress").mockRejectedValue(
      new Error("router offline")
    )
    const resumeSolSpy = vi.spyOn(privateSwap, "resumeSwapAtFreshAddress")

    const resolved = await reconcileSwapOutputs(conn, "testShieldedAddress")

    // Must NOT mark resolved, must NOT call SOL-only resume, and must NOT mark gas as landed
    expect(resolved).toBe(0)
    expect(resumeSolSpy).not.toHaveBeenCalled()

    const stored = await listSwapOutputs()
    expect(stored[0].swapSignature).toBe("")
    expect(stored[0].outAmount).toBe(0) // NOT 6_500_000
  })

  it("Case 1 (token -> SOL): successfully resumes swap using input tokens when router is reachable", async () => {
    const fresh = Keypair.generate()
    const swapRow: SwapOutput = {
      freshAddress: fresh.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(fresh.secretKey).toString("hex"),
      inputMint: USDC_MINT,
      inputAmount: "5000000",
      outputMint: WSOL_MINT,
      outAmount: 0,
      swapSignature: "",
      createdAt: Date.now() - OLD
    }
    await saveSwapOutput(swapRow)

    const conn = makeMockConnection({
      solLamports: 6_500_000n,
      tokenAccounts: {
        [USDC_MINT]: 5_000_000n
      },
      signatures: ["gas_funding_tx_sig"]
    })

    vi.spyOn(privateSwap, "resumeTokenSwapAtFreshAddress").mockResolvedValue({
      swapSignature: "real_token_swap_tx_sig",
      outAmount: 34_500_000
    })

    const resolved = await reconcileSwapOutputs(conn, "testShieldedAddress")

    expect(resolved).toBe(1)
    const stored = await listSwapOutputs()
    expect(stored[0].swapSignature).toBe("real_token_swap_tx_sig")
    expect(stored[0].outAmount).toBe(34_500_000)
  })

  it("Case 2 (token -> token): delegates to resumeTokenSwapAtFreshAddress and NEVER calls SOL-only resume", async () => {
    const fresh = Keypair.generate()
    const swapRow: SwapOutput = {
      freshAddress: fresh.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(fresh.secretKey).toString("hex"),
      inputMint: USDC_MINT,
      inputAmount: "5000000",
      outputMint: BONK_MINT,
      outAmount: 0,
      swapSignature: "",
      createdAt: Date.now() - OLD
    }
    await saveSwapOutput(swapRow)

    const conn = makeMockConnection({
      solLamports: 6_500_000n, // leftover gas SOL > RESUME_MIN_LAMPORTS
      tokenAccounts: {
        [USDC_MINT]: 5_000_000n,
        [BONK_MINT]: 0n
      }
    })

    const resumeTokenSpy = vi
      .spyOn(privateSwap, "resumeTokenSwapAtFreshAddress")
      .mockResolvedValue({
        swapSignature: "bonk_token_swap_sig",
        outAmount: 99_000_000
      })
    const resumeSolSpy = vi.spyOn(privateSwap, "resumeSwapAtFreshAddress")

    const resolved = await reconcileSwapOutputs(conn, "testShieldedAddress")

    expect(resolved).toBe(1)
    expect(resumeTokenSpy).toHaveBeenCalledWith(
      conn,
      "testShieldedAddress",
      swapRow.freshSecretKeyHex,
      USDC_MINT,
      BONK_MINT,
      false,
      expect.any(Function)
    )
    expect(resumeSolSpy).not.toHaveBeenCalled()

    const stored = await listSwapOutputs()
    expect(stored[0].swapSignature).toBe("bonk_token_swap_sig")
    expect(stored[0].outAmount).toBe(99_000_000)
  })

  it("records landed token output when swap already executed on-chain (input spent, output present)", async () => {
    const fresh = Keypair.generate()
    const swapRow: SwapOutput = {
      freshAddress: fresh.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(fresh.secretKey).toString("hex"),
      inputMint: USDC_MINT,
      inputAmount: "5000000",
      outputMint: BONK_MINT,
      outAmount: 0,
      swapSignature: "",
      createdAt: Date.now() - OLD
    }
    await saveSwapOutput(swapRow)

    const conn = makeMockConnection({
      solLamports: 4_500_000n,
      tokenAccounts: {
        [USDC_MINT]: 0n,
        [BONK_MINT]: 88_888_888n
      },
      signatures: ["landed_bonk_tx"]
    })

    const resolved = await reconcileSwapOutputs(conn, "testShieldedAddress")

    expect(resolved).toBe(1)
    const stored = await listSwapOutputs()
    expect(stored[0].swapSignature).toBe("landed_bonk_tx")
    expect(stored[0].outAmount).toBe(88_888_888)
  })

  it("does not mistake leftover gas SOL for completion when token withdraw never settled", async () => {
    const fresh = Keypair.generate()
    const swapRow: SwapOutput = {
      freshAddress: fresh.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(fresh.secretKey).toString("hex"),
      inputMint: USDC_MINT,
      inputAmount: "5000000",
      outputMint: "SOL",
      outAmount: 0,
      swapSignature: "",
      createdAt: Date.now() - OLD
    }
    await saveSwapOutput(swapRow)

    const conn = makeMockConnection({
      solLamports: 6_500_000n,
      tokenAccounts: {
        [USDC_MINT]: 0n
      },
      signatures: ["gas_funding_tx"]
    })

    const resolved = await reconcileSwapOutputs(conn, "testShieldedAddress")

    expect(resolved).toBe(0)
    const stored = await listSwapOutputs()
    expect(stored[0].swapSignature).toBe("")
    expect(stored[0].outAmount).toBe(0)
  })

  it("preserves native SOL input swap recovery flow", async () => {
    const fresh = Keypair.generate()
    const swapRow: SwapOutput = {
      freshAddress: fresh.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(fresh.secretKey).toString("hex"),
      inputMint: "SOL",
      outputMint: USDC_MINT,
      outAmount: 0,
      swapSignature: "",
      createdAt: Date.now() - OLD
    }
    await saveSwapOutput(swapRow)

    const conn = makeMockConnection({
      solLamports: 10_000_000n, // swappable SOL > RESUME_MIN_LAMPORTS
      tokenAccounts: {
        [USDC_MINT]: 0n
      }
    })

    const resumeSolSpy = vi
      .spyOn(privateSwap, "resumeSwapAtFreshAddress")
      .mockResolvedValue({
        swapSignature: "sol_swap_resumed_sig",
        outAmount: 15_000_000
      })

    const resolved = await reconcileSwapOutputs(conn, "testShieldedAddress")

    expect(resolved).toBe(1)
    expect(resumeSolSpy).toHaveBeenCalled()
    const stored = await listSwapOutputs()
    expect(stored[0].swapSignature).toBe("sol_swap_resumed_sig")
    expect(stored[0].outAmount).toBe(15_000_000)
  })
})
