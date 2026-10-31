import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  assetIdForMint: async () => "00".repeat(32)
}))

import { Keypair, type Connection } from "@solana/web3.js"
import { recoverReshields } from "~lib/paraloom/reshieldRecovery"
import { saveSwapOutput, type SwapOutput } from "~lib/paraloom/swapOutputs"
import { WSOL_MINT, isNativeSolOutput } from "~lib/paraloom/swapReconcileClassify"
import { inputInfo, tokenLabel } from "~src/popup/SwapApprove"
import { installFakeChrome } from "./support/chromeStorage"

beforeEach(() => {
  installFakeChrome()
})

describe("WSOL_MINT native SOL handling across SwapApprove, reshieldRecovery, and swap classification (#157)", () => {
  it("recognizes both 'SOL' and WSOL_MINT as native SOL outputs", () => {
    expect(isNativeSolOutput("SOL")).toBe(true)
    expect(isNativeSolOutput(WSOL_MINT)).toBe(true)
    expect(isNativeSolOutput("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(false)
  })

  it("formats tokenLabel and inputInfo for WSOL_MINT as SOL with 9 decimals", () => {
    expect(tokenLabel("SOL")).toBe("SOL")
    expect(tokenLabel(WSOL_MINT)).toBe("SOL")
    expect(inputInfo("SOL")).toEqual({ decimals: 9, symbol: "SOL" })
    expect(inputInfo(WSOL_MINT)).toEqual({ decimals: 9, symbol: "SOL" })
    expect(inputInfo(undefined)).toEqual({ decimals: 9, symbol: "SOL" })
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
