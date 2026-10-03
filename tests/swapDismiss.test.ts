import { Keypair, type Connection } from "@solana/web3.js"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { resumeSwapAtFreshAddress } = vi.hoisted(() => ({
  resumeSwapAtFreshAddress: vi.fn(async () => ({
    swapSignature: "resumed-signature",
    outAmount: 123,
    reshielded: undefined
  }))
}))

vi.mock("../lib/paraloom/privateSwap", () => ({
  isNativeSolOutput: () => false,
  resumeSwapAtFreshAddress
}))
vi.mock("../lib/paraloom/reshieldRecovery", () => ({
  persistReshieldedNote: vi.fn()
}))

import { reconcileSwapOutputs } from "../lib/paraloom/swapReconcile"
import { dismissSwapOutput, listSwapOutputs, saveSwapOutput } from "../lib/paraloom/swapOutputs"
import { installFakeChrome } from "./support/chromeStorage"

const ACCOUNT = `paraloom1${"11".repeat(64)}`
const fresh = Keypair.generate()
const secretHex = Buffer.from(fresh.secretKey).toString("hex")

beforeEach(() => {
  installFakeChrome()
  resumeSwapAtFreshAddress.mockClear()
})

describe("dismissed pending swaps", () => {
  it("hides the row but keeps its key and lets reconciliation resume it", async () => {
    await saveSwapOutput({
      freshAddress: fresh.publicKey.toBase58(),
      freshSecretKeyHex: secretHex,
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outAmount: 0,
      swapSignature: "",
      createdAt: Date.now() - 10 * 60_000
    })
    await dismissSwapOutput(fresh.publicKey.toBase58())

    const connection = {
      getBalance: vi.fn(async () => 8_000_000)
    } as unknown as Connection
    expect(await reconcileSwapOutputs(connection, ACCOUNT)).toBe(1)

    const [row] = await listSwapOutputs()
    expect(row.dismissed).toBe(true)
    expect(row.freshSecretKeyHex).toBe(secretHex)
    expect(row.swapSignature).toBe("resumed-signature")
    expect(resumeSwapAtFreshAddress).toHaveBeenCalledWith(
      connection,
      ACCOUNT,
      secretHex,
      row.outputMint,
      false,
      expect.any(Function)
    )
  })
})
