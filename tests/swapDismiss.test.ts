import { describe, expect, it, beforeEach } from "vitest"
import { Keypair } from "@solana/web3.js"
import {
  dismissSwapOutput,
  listSwapOutputs,
  saveSwapOutput,
  type SwapOutput
} from "~lib/paraloom/swapOutputs"
import { installFakeChrome } from "./support/chromeStorage"

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

describe("dismissSwapOutput preserves secret key (#854)", () => {
  beforeEach(() => {
    installFakeChrome()
  })

  it("marks row dismissed and hides it from UI without deleting freshSecretKeyHex", async () => {
    const fresh = Keypair.generate()
    const freshSecretKeyHex = Buffer.from(fresh.secretKey).toString("hex")
    const freshAddress = fresh.publicKey.toBase58()

    const output: SwapOutput = {
      freshAddress,
      freshSecretKeyHex,
      outputMint: USDC_MINT,
      outAmount: 0,
      swapSignature: "",
      createdAt: Date.now() - 100_000
    }

    await saveSwapOutput(output)

    // Initially listed for UI
    const initialList = await listSwapOutputs()
    expect(initialList).toHaveLength(1)
    expect(initialList[0].freshAddress).toBe(freshAddress)

    // User dismisses the pending row
    await dismissSwapOutput(freshAddress)

    // 1. UI list (default includeDismissed=false) no longer displays the row
    const uiList = await listSwapOutputs()
    expect(uiList).toHaveLength(0)

    // 2. Full list (reconciliation/recovery) still contains the row with its secret key
    const fullList = await listSwapOutputs(true)
    expect(fullList).toHaveLength(1)
    expect(fullList[0].freshAddress).toBe(freshAddress)
    expect(fullList[0].freshSecretKeyHex).toBe(freshSecretKeyHex)
    expect(fullList[0].dismissed).toBe(true)

    // 3. Raw storage verification: the secret key was NOT deleted
    const rawStorage = await chrome.storage.local.get("paraloom_swap_outputs")
    const storedRows = rawStorage["paraloom_swap_outputs"] as SwapOutput[]
    expect(storedRows).toHaveLength(1)
    expect(storedRows[0].freshSecretKeyHex).toBe(freshSecretKeyHex)
  })

  it("leaves other swap outputs untouched when dismissing a specific row", async () => {
    const fresh1 = Keypair.generate()
    const fresh2 = Keypair.generate()

    await saveSwapOutput({
      freshAddress: fresh1.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(fresh1.secretKey).toString("hex"),
      outputMint: USDC_MINT,
      outAmount: 0,
      swapSignature: "",
      createdAt: Date.now()
    })

    await saveSwapOutput({
      freshAddress: fresh2.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(fresh2.secretKey).toString("hex"),
      outputMint: "SOL",
      outAmount: 10_000_000,
      swapSignature: "sig-2",
      createdAt: Date.now()
    })

    await dismissSwapOutput(fresh1.publicKey.toBase58())

    const active = await listSwapOutputs()
    expect(active).toHaveLength(1)
    expect(active[0].freshAddress).toBe(fresh2.publicKey.toBase58())

    const all = await listSwapOutputs(true)
    expect(all).toHaveLength(2)
  })
})
