import { beforeEach, describe, expect, it, vi } from "vitest"
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  assetIdForMint: vi.fn().mockResolvedValue("11".repeat(32))
}))

const mockRouteSwap = vi.fn()
vi.mock("../lib/paraloom/privateSwap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/paraloom/privateSwap")>()
  return {
    ...actual
  }
})

import { installFakeChrome } from "./support/chromeStorage"
import { listSwapOutputs, saveSwapOutput, type SwapOutput } from "../lib/paraloom/swapOutputs"
import { reconcileSwapOutputs, RESUME_GRACE_MS } from "../lib/paraloom/swapReconcile"

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
const WSOL_MINT = "So11111111111111111111111111111111111111112"
const SHIELDED_ADDR = "paraloom1" + "33".repeat(64)

function makeMockConnection(options: {
  solLamports?: bigint
  tokenBalancesByMint?: Record<string, bigint>
  signatures?: string[]
}) {
  return {
    getBalance: vi.fn().mockResolvedValue(Number(options.solLamports ?? 0n)),
    getParsedTokenAccountsByOwner: vi.fn().mockImplementation(async (_owner, filter) => {
      const balances = options.tokenBalancesByMint ?? {}
      if (filter?.mint) {
        const mintStr = filter.mint.toBase58()
        const bal = balances[mintStr] ?? 0n
        return {
          value: [
            {
              account: {
                data: {
                  parsed: {
                    info: {
                      mint: mintStr,
                      tokenAmount: { amount: bal.toString() }
                    }
                  }
                }
              }
            }
          ]
        }
      }
      // Return all non-zero token accounts if filtered by programId
      const value = Object.entries(balances).map(([mint, bal]) => ({
        account: {
          data: {
            parsed: {
              info: {
                mint,
                tokenAmount: { amount: bal.toString() }
              }
            }
          }
        }
      }))
      return { value }
    }),
    getTokenAccountBalance: vi.fn().mockImplementation(async (_ata) => {
      // Find balance or return default
      return { value: { amount: "5000000" } }
    }),
    getSignaturesForAddress: vi.fn().mockResolvedValue(
      (options.signatures ?? []).map((sig) => ({ signature: sig }))
    ),
    sendRawTransaction: vi.fn().mockResolvedValue("mock-tx-sig-123"),
    getSignatureStatus: vi.fn().mockResolvedValue({
      value: { confirmationStatus: "confirmed", err: null }
    })
  } as any
}

describe("reconcileSwapOutputs token-input recovery (#855)", () => {
  beforeEach(() => {
    installFakeChrome()
    vi.clearAllMocks()
  })

  it("never classifies token -> SOL as landed using leftover gas SOL when input token is unswapped", async () => {
    const fresh = Keypair.generate()
    const row: SwapOutput = {
      freshAddress: fresh.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(fresh.secretKey).toString("hex"),
      inputMint: USDC_MINT,
      outputMint: "SOL",
      outAmount: 0,
      swapSignature: "",
      createdAt: Date.now() - (RESUME_GRACE_MS + 5000)
    }
    await saveSwapOutput(row)

    // Fresh address holds 6.5M lamports leftover gas SOL and 5M units of USDC
    const connection = makeMockConnection({
      solLamports: 6_500_000n,
      tokenBalancesByMint: {
        [USDC_MINT]: 5_000_000n
      },
      signatures: ["gas-fund-tx-sig"]
    })

    // Mock fetch for swap route to simulate a failing route service (cannot complete swap leg right now)
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Route service 503"))

    const resolved = await reconcileSwapOutputs(connection, SHIELDED_ADDR)

    // The reconciler must NOT mark the row landed with 6.5M SOL and gas-fund-tx-sig!
    expect(resolved).toBe(0)

    const stored = await listSwapOutputs()
    const updated = stored.find((o) => o.freshAddress === fresh.publicKey.toBase58())!
    expect(updated.swapSignature).toBe("") // still pending, funds protected!
    expect(updated.outAmount).toBe(0) // not overwritten with gas SOL!
  })

  it("never invokes SOL-only resume for a token -> token swap (#855)", async () => {
    const fresh = Keypair.generate()
    const row: SwapOutput = {
      freshAddress: fresh.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(fresh.secretKey).toString("hex"),
      inputMint: USDC_MINT,
      outputMint: BONK_MINT,
      outAmount: 0,
      swapSignature: "",
      createdAt: Date.now() - (RESUME_GRACE_MS + 5000)
    }
    await saveSwapOutput(row)

    const connection = makeMockConnection({
      solLamports: 6_500_000n, // leftover gas
      tokenBalancesByMint: {
        [USDC_MINT]: 5_000_000n,
        [BONK_MINT]: 0n
      },
      signatures: ["gas-fund-tx-sig"]
    })

    let routeInputMintCalled: string | undefined
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
      if (opts?.body) {
        try {
          const parsed = JSON.parse(opts.body as string)
          routeInputMintCalled = parsed.input_mint
        } catch {}
      }
      return {
        ok: true,
        json: async () => ({
          out_amount: 100_000_000,
          swap_transaction: Buffer.from(new Uint8Array(64)).toString("base64")
        })
      }
    })

    vi.spyOn(VersionedTransaction, "deserialize").mockReturnValue({
      sign: vi.fn(),
      serialize: vi.fn().mockReturnValue(new Uint8Array(10))
    } as any)

    // When connection.sendRawTransaction throws, resume is attempted with inputMint
    connection.sendRawTransaction = vi.fn().mockRejectedValue(new Error("simulated stop"))

    await reconcileSwapOutputs(connection, SHIELDED_ADDR)

    // It must route with inputMint = USDC_MINT, NOT the leftover gas SOL!
    expect(routeInputMintCalled).toBe(USDC_MINT)
  })

  it("marks token -> SOL swap landed when input token is gone and SOL exceeds gas funding reserve", async () => {
    const fresh = Keypair.generate()
    const row: SwapOutput = {
      freshAddress: fresh.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(fresh.secretKey).toString("hex"),
      inputMint: USDC_MINT,
      outputMint: "SOL",
      outAmount: 0,
      swapSignature: "",
      createdAt: Date.now() - (RESUME_GRACE_MS + 5000)
    }
    await saveSwapOutput(row)

    const connection = makeMockConnection({
      solLamports: 45_000_000n, // Realized swap output + gas
      tokenBalancesByMint: {
        [USDC_MINT]: 0n
      },
      signatures: ["dex-swap-landed-sig"]
    })

    const resolved = await reconcileSwapOutputs(connection, SHIELDED_ADDR)
    expect(resolved).toBe(1)

    const stored = await listSwapOutputs()
    const updated = stored.find((o) => o.freshAddress === fresh.publicKey.toBase58())!
    expect(updated.swapSignature).toBe("dex-swap-landed-sig")
    expect(updated.outAmount).toBe(45_000_000)
  })

  it("marks token -> token swap landed when input token is consumed and output token is present", async () => {
    const fresh = Keypair.generate()
    const row: SwapOutput = {
      freshAddress: fresh.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(fresh.secretKey).toString("hex"),
      inputMint: USDC_MINT,
      outputMint: BONK_MINT,
      outAmount: 0,
      swapSignature: "",
      createdAt: Date.now() - (RESUME_GRACE_MS + 5000)
    }
    await saveSwapOutput(row)

    const connection = makeMockConnection({
      solLamports: 6_450_000n,
      tokenBalancesByMint: {
        [USDC_MINT]: 0n,
        [BONK_MINT]: 250_000_000n
      },
      signatures: ["dex-bonk-landed-sig"]
    })

    const resolved = await reconcileSwapOutputs(connection, SHIELDED_ADDR)
    expect(resolved).toBe(1)

    const stored = await listSwapOutputs()
    const updated = stored.find((o) => o.freshAddress === fresh.publicKey.toBase58())!
    expect(updated.swapSignature).toBe("dex-bonk-landed-sig")
    expect(updated.outAmount).toBe(250_000_000)
  })

  it("discovers unswapped input tokens even on legacy rows where inputMint was omitted", async () => {
    const fresh = Keypair.generate()
    // Legacy row without inputMint:
    const row: SwapOutput = {
      freshAddress: fresh.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(fresh.secretKey).toString("hex"),
      outputMint: "SOL",
      outAmount: 0,
      swapSignature: "",
      createdAt: Date.now() - (RESUME_GRACE_MS + 5000)
    }
    await saveSwapOutput(row)

    const connection = makeMockConnection({
      solLamports: 6_500_000n,
      tokenBalancesByMint: {
        [USDC_MINT]: 5_000_000n
      },
      signatures: ["gas-fund-tx-sig"]
    })

    // Reject fetch so resume fails safely
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Route offline"))

    const resolved = await reconcileSwapOutputs(connection, SHIELDED_ADDR)

    // Legacy row must NOT be marked landed with 6.5M gas SOL!
    expect(resolved).toBe(0)

    const stored = await listSwapOutputs()
    const updated = stored.find((o) => o.freshAddress === fresh.publicKey.toBase58())!
    expect(updated.swapSignature).toBe("")
    expect(updated.outAmount).toBe(0)
  })
})
