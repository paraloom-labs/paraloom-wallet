import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  assetIdForMint: async () => "00".repeat(32)
}))

import { Keypair, type Connection } from "@solana/web3.js"
import { recoverReshields } from "~lib/paraloom/reshieldRecovery"
import { saveSwapOutput, type SwapOutput } from "~lib/paraloom/swapOutputs"
import { WSOL_MINT, isNativeSolOutput } from "~lib/paraloom/swapReconcileClassify"
import { installFakeChrome } from "./support/chromeStorage"

beforeEach(() => {
  installFakeChrome()
})

describe("WSOL_MINT native SOL handling across reshieldRecovery and swap classification", () => {
  it("recognizes both 'SOL' and WSOL_MINT as native SOL outputs", () => {
    expect(isNativeSolOutput("SOL")).toBe(true)
    expect(isNativeSolOutput(WSOL_MINT)).toBe(true)
    expect(isNativeSolOutput("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(false)
  })

  it("skips recoverReshields RPC polling when outputMint is WSOL_MINT", async () => {
    const kp = Keypair.generate()
    const wsolSwap: SwapOutput = {
      freshAddress: kp.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(kp.secretKey).toString("hex"),
      outputMint: WSOL_MINT,
      outAmount: 990000000,
      swapSignature: "swap-sig",
      createdAt: Date.now(),
      reshield: true
    }
    await saveSwapOutput(wsolSwap)

    const getSignaturesForAddress = vi.fn()
    const getTokenAccountBalance = vi.fn()
    const conn = {
      getSignaturesForAddress,
      getTokenAccountBalance
    } as unknown as Connection

    const recovered = await recoverReshields(conn, "paraloom1" + "11".repeat(64))
    expect(recovered).toBe(0)
    expect(getSignaturesForAddress).not.toHaveBeenCalled()
    expect(getTokenAccountBalance).not.toHaveBeenCalled()
  })
})
