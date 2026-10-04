import { beforeEach, describe, expect, it, vi } from "vitest"
import { Keypair, PublicKey } from "@solana/web3.js"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  assetIdForMint: vi.fn().mockResolvedValue("11".repeat(32))
}))

import { installFakeChrome } from "./support/chromeStorage"
import { listSwapOutputs, saveSwapOutput, type SwapOutput } from "../lib/paraloom/swapOutputs"
import { reconcileSwapOutputs, RESUME_GRACE_MS } from "../lib/paraloom/swapReconcile"

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const SHIELDED_ADDR = "paraloom1" + "44".repeat(64)

function makeMockConnection(options: {
  solLamports?: bigint
  signatureStatus?: { confirmationStatus: "confirmed" | "finalized" | "processed" | null; err: any } | null
  resumedSignature?: string
}) {
  return {
    getBalance: vi.fn().mockResolvedValue(Number(options.solLamports ?? 0n)),
    getParsedTokenAccountsByOwner: vi.fn().mockResolvedValue({ value: [] }),
    getSignatureStatus: vi.fn().mockResolvedValue({
      value: options.signatureStatus ?? null
    }),
    getSignaturesForAddress: vi.fn().mockResolvedValue([]),
    sendRawTransaction: vi.fn().mockResolvedValue(options.resumedSignature ?? "new-resumed-sig-456")
  } as any
}

describe("reconcileSwapOutputs submitted vs confirmed recovery (#856)", () => {
  beforeEach(() => {
    installFakeChrome()
    vi.clearAllMocks()
  })

  it("does not skip submitted unconfirmed swap when tx drops, and recovers stranded SOL (#856)", async () => {
    const fresh = Keypair.generate()
    // Row saved between sendRawTransaction and waitForSwapConfirmation:
    const row: SwapOutput = {
      freshAddress: fresh.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(fresh.secretKey).toString("hex"),
      outputMint: USDC_MINT,
      outAmount: 50_000_000,
      swapSignature: "dropped-tx-signature-123",
      status: "submitted",
      confirmed: false,
      createdAt: Date.now() - (RESUME_GRACE_MS + 5000)
    }
    await saveSwapOutput(row)

    // RPC reports signature was dropped (null status), but fresh address still holds 15,000,000 lamports SOL
    const connection = makeMockConnection({
      solLamports: 15_000_000n,
      signatureStatus: null, // dropped transaction
      resumedSignature: "new-resumed-tx-sig-789"
    })

    // Mock fetch for swap route and confirmation wait
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        out_amount: 51_000_000,
        swap_transaction: Buffer.from(new Uint8Array(64)).toString("base64")
      })
    })

    // Mock VersionedTransaction
    const { VersionedTransaction } = await import("@solana/web3.js")
    vi.spyOn(VersionedTransaction, "deserialize").mockReturnValue({
      sign: vi.fn(),
      serialize: vi.fn().mockReturnValue(new Uint8Array(10))
    } as any)

    // When connection polls signature status for the resumed swap, report confirmed
    let callCount = 0
    connection.getSignatureStatus = vi.fn().mockImplementation(async (sig: string) => {
      if (sig === "dropped-tx-signature-123") {
        return { value: null } // dropped!
      }
      return { value: { confirmationStatus: "confirmed", err: null } }
    })

    const resolved = await reconcileSwapOutputs(connection, SHIELDED_ADDR)
    expect(resolved).toBe(1)

    const stored = await listSwapOutputs()
    const updated = stored.find((o) => o.freshAddress === fresh.publicKey.toBase58())!
    expect(updated.swapSignature).toBe("new-resumed-tx-sig-789")
    expect(updated.outAmount).toBe(51_000_000)
    expect(updated.confirmed).toBe(true)
    expect(updated.status).toBe("confirmed")
  })

  it("verifies and marks row confirmed when submitted signature landed on-chain", async () => {
    const fresh = Keypair.generate()
    const row: SwapOutput = {
      freshAddress: fresh.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(fresh.secretKey).toString("hex"),
      outputMint: USDC_MINT,
      outAmount: 50_000_000,
      swapSignature: "valid-landed-sig-123",
      status: "submitted",
      confirmed: false,
      createdAt: Date.now() - (RESUME_GRACE_MS + 5000)
    }
    await saveSwapOutput(row)

    const connection = makeMockConnection({
      solLamports: 1_000_000n,
      signatureStatus: { confirmationStatus: "confirmed", err: null }
    })

    const resolved = await reconcileSwapOutputs(connection, SHIELDED_ADDR)
    // Does not re-swap because it was already confirmed on-chain
    expect(resolved).toBe(0)

    const stored = await listSwapOutputs()
    const updated = stored.find((o) => o.freshAddress === fresh.publicKey.toBase58())!
    expect(updated.confirmed).toBe(true)
    expect(updated.status).toBe("confirmed")
    expect(connection.getBalance).not.toHaveBeenCalled()
  })

  it("skips rows that are already confirmed without querying RPC", async () => {
    const fresh = Keypair.generate()
    const row: SwapOutput = {
      freshAddress: fresh.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(fresh.secretKey).toString("hex"),
      outputMint: USDC_MINT,
      outAmount: 50_000_000,
      swapSignature: "already-confirmed-sig",
      status: "confirmed",
      confirmed: true,
      createdAt: Date.now() - (RESUME_GRACE_MS + 5000)
    }
    await saveSwapOutput(row)

    const connection = makeMockConnection({
      solLamports: 0n
    })

    const resolved = await reconcileSwapOutputs(connection, SHIELDED_ADDR)
    expect(resolved).toBe(0)
    expect(connection.getSignatureStatus).not.toHaveBeenCalled()
    expect(connection.getBalance).not.toHaveBeenCalled()
  })
})
