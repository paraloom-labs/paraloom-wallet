import { describe, expect, it, vi } from "vitest"
import { Keypair, PublicKey } from "@solana/web3.js"
import { depositSpl } from "~lib/paraloom/bridge"

// Mock connection
const mockConnection = {
  getLatestBlockhash: vi.fn().mockResolvedValue({
    blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
    lastValidBlockHeight: 1000
  }),
  sendRawTransaction: vi.fn().mockResolvedValue("mock-tx-signature-xyz"),
  getSignatureStatus: vi.fn()
}

// Mock confirmBySignatureStatus
vi.mock("~lib/paraloom/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~lib/paraloom/bridge")>()
  return {
    ...actual
  }
})

describe("depositSpl confirmation timeout handling", () => {
  const payer = Keypair.generate()
  const shieldedAddress = "shielded-addr"
  const mint = new PublicKey("So11111111111111111111111111111111111111112")
  const amount = 1000000n
  const assetId = "00".repeat(32)

  it("throws descriptive error when confirmBySignatureStatus returns false on confirmation timeout", async () => {
    // Mock getSignatureStatus returning null or unconfirmed
    mockConnection.getSignatureStatus.mockResolvedValue({ value: null })

    // Provide short timeoutMs so test finishes instantly
    await expect(
      depositSpl(
        mockConnection as any,
        payer,
        shieldedAddress,
        mint,
        amount,
        assetId
      )
    ).rejects.toThrow("failed to confirm on-chain within timeout")
  })
})
