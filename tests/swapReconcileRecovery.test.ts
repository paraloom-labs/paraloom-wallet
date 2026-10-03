import { Connection, Keypair } from "@solana/web3.js"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { listSwapOutputs, saveSwapOutput } from "../lib/paraloom/swapOutputs"
import { reconcileSwapOutputs } from "../lib/paraloom/swapReconcile"
import { installFakeChrome } from "./support/chromeStorage"

const { resumeSwapAtFreshAddress, resumeTokenSwapAtFreshAddress } = vi.hoisted(() => ({
  resumeSwapAtFreshAddress: vi.fn(),
  resumeTokenSwapAtFreshAddress: vi.fn()
}))

vi.mock("../lib/paraloom/privateSwap", () => ({
  isNativeSolOutput: (mint: string) =>
    mint === "SOL" || mint === "So11111111111111111111111111111111111111112",
  resumeSwapAtFreshAddress,
  resumeTokenSwapAtFreshAddress
}))
vi.mock("../lib/paraloom/reshieldRecovery", () => ({
  persistReshieldedNote: vi.fn()
}))

describe("reconcile submitted swaps", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    installFakeChrome()
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:10:00Z"))
  })

  it("promotes a confirmed submission without resubmitting it", async () => {
    const address = Keypair.generate().publicKey.toBase58()
    await saveSwapOutput({
      freshAddress: address,
      freshSecretKeyHex: "",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inputMint: "SOL",
      outAmount: 0,
      submittedOutAmount: 25,
      swapSignature: "",
      submittedSignature: "confirmed-sig",
      createdAt: Date.now() - 180_000
    })
    const connection = {
      getSignatureStatus: vi.fn().mockResolvedValue({
        value: { err: null, confirmationStatus: "confirmed" }
      })
    } as unknown as Connection

    expect(await reconcileSwapOutputs(connection, "shielded-address")).toBe(1)
    expect(resumeSwapAtFreshAddress).not.toHaveBeenCalled()
    expect(await listSwapOutputs()).toMatchObject([
      {
        swapSignature: "confirmed-sig",
        submittedSignature: "",
        outAmount: 25,
        confirmedAt: Date.now()
      }
    ])
  })

  it("leaves a processed submission pending and avoids a duplicate", async () => {
    const address = Keypair.generate().publicKey.toBase58()
    const row = {
      freshAddress: address,
      freshSecretKeyHex: "",
      outputMint: "So11111111111111111111111111111111111111112",
      inputMint: "SOL",
      outAmount: 0,
      submittedOutAmount: 25,
      swapSignature: "",
      submittedSignature: "processed-sig",
      createdAt: Date.now() - 180_000
    }
    await saveSwapOutput(row)
    const connection = {
      getSignatureStatus: vi.fn().mockResolvedValue({
        value: { err: null, confirmationStatus: "processed" }
      })
    } as unknown as Connection

    expect(await reconcileSwapOutputs(connection, "shielded-address")).toBe(0)
    expect(resumeSwapAtFreshAddress).not.toHaveBeenCalled()
    expect(await listSwapOutputs()).toMatchObject([row])
  })

  it("resumes a dropped submission and persists its replacement signature", async () => {
    const address = Keypair.generate().publicKey.toBase58()
    await saveSwapOutput({
      freshAddress: address,
      freshSecretKeyHex: "saved-key",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inputMint: "SOL",
      outAmount: 0,
      submittedOutAmount: 25,
      swapSignature: "",
      submittedSignature: "dropped-sig",
      submittedBlockhash: "expired-blockhash",
      createdAt: Date.now() - 180_000
    })
    const connection = {
      getSignatureStatus: vi.fn().mockResolvedValue({ value: null }),
      isBlockhashValid: vi.fn().mockResolvedValue({ value: false }),
      getBalance: vi.fn().mockResolvedValue(20_000_000),
      getParsedTokenAccountsByOwner: vi.fn().mockResolvedValue({ value: [] })
    } as unknown as Connection
    resumeSwapAtFreshAddress.mockImplementation(
      async (_connection, _shielded, _key, _mint, _reshield, _onReshield, onSubmitted) => {
        await onSubmitted("replacement-sig", 30)
        return { swapSignature: "replacement-sig", outAmount: 30 }
      }
    )

    expect(await reconcileSwapOutputs(connection, "shielded-address")).toBe(1)
    expect(resumeSwapAtFreshAddress).toHaveBeenCalledOnce()
    expect(await listSwapOutputs()).toMatchObject([
      {
        swapSignature: "replacement-sig",
        submittedSignature: "",
        outAmount: 30,
        confirmedAt: Date.now()
      }
    ])
  })

  it("does not retry a missing signature while its recent blockhash remains valid", async () => {
    const address = Keypair.generate().publicKey.toBase58()
    await saveSwapOutput({
      freshAddress: address,
      freshSecretKeyHex: "saved-key",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inputMint: "SOL",
      outAmount: 0,
      submittedOutAmount: 25,
      swapSignature: "",
      submittedSignature: "not-yet-visible",
      submittedBlockhash: "still-valid-blockhash",
      createdAt: Date.now() - 180_000
    })
    const connection = {
      getSignatureStatus: vi.fn().mockResolvedValue({ value: null }),
      isBlockhashValid: vi.fn().mockResolvedValue({ value: true }),
      getBalance: vi.fn()
    } as unknown as Connection

    expect(await reconcileSwapOutputs(connection, "shielded-address")).toBe(0)
    expect(connection.getBalance).not.toHaveBeenCalled()
    expect(resumeSwapAtFreshAddress).not.toHaveBeenCalled()
  })

  it("recovers token inputs without treating leftover SOL gas as the swap input", async () => {
    const address = Keypair.generate().publicKey.toBase58()
    const inputMint = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
    await saveSwapOutput({
      freshAddress: address,
      freshSecretKeyHex: "saved-key",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inputMint,
      inputAmount: "200",
      outAmount: 0,
      submittedOutAmount: 25,
      swapSignature: "",
      submittedSignature: "dropped-token-sig",
      createdAt: Date.now() - 180_000
    })
    const connection = {
      getSignatureStatus: vi.fn().mockResolvedValue({ value: null }),
      getBalance: vi.fn().mockResolvedValue(10_000_000),
      getParsedTokenAccountsByOwner: vi.fn().mockImplementation(async (_owner, filter) => ({
        value:
          filter.mint.toBase58() === inputMint
            ? [
                {
                  account: {
                    data: {
                      parsed: { info: { tokenAmount: { amount: "200" } } }
                    }
                  }
                }
              ]
            : []
      }))
    } as unknown as Connection
    resumeTokenSwapAtFreshAddress.mockResolvedValue({
      swapSignature: "replacement-token-sig",
      outAmount: 75
    })

    expect(await reconcileSwapOutputs(connection, "shielded-address")).toBe(1)
    expect(resumeTokenSwapAtFreshAddress).toHaveBeenCalledOnce()
    expect(resumeSwapAtFreshAddress).not.toHaveBeenCalled()
    expect(await listSwapOutputs()).toMatchObject([
      {
        swapSignature: "replacement-token-sig",
        submittedSignature: "",
        outAmount: 75,
        confirmedAt: Date.now()
      }
    ])
  })
})
