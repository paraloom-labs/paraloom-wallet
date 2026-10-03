import { beforeEach, describe, expect, it } from "vitest"
import {
  dismissSwapOutput,
  listSwapOutputs,
  saveSwapOutput,
  type SwapOutput
} from "~lib/paraloom/swapOutputs"
import { installFakeChrome } from "./support/chromeStorage"

describe("dismissSwapOutput", () => {
  beforeEach(() => {
    installFakeChrome()
  })

  it("marks a pending swap as dismissed rather than deleting it and its private key", async () => {
    const dummyKey = "deadbeef".repeat(8)
    const dummyAddress = "FreshAddress111111111111111111111111111111"

    const row: SwapOutput = {
      freshAddress: dummyAddress,
      freshSecretKeyHex: dummyKey,
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outAmount: 0,
      swapSignature: "",
      createdAt: Date.now() - 600_000
    }

    await saveSwapOutput(row)

    // Verify it is saved
    const before = await listSwapOutputs()
    expect(before).toHaveLength(1)
    expect(before[0].freshSecretKeyHex).toBe(dummyKey)
    expect(before[0].dismissed).toBeUndefined()

    // Dismiss the row
    await dismissSwapOutput(dummyAddress)

    // The row must still exist in storage with its key intact!
    const after = await listSwapOutputs()
    expect(after).toHaveLength(1)
    expect(after[0].freshAddress).toBe(dummyAddress)
    expect(after[0].freshSecretKeyHex).toBe(dummyKey)
    expect(after[0].dismissed).toBe(true)

    // Raw chrome.storage must retain the recovery key
    const rawStorage = (globalThis as any).chrome.storage.local.raw
    expect(JSON.stringify(rawStorage)).toContain(dummyKey)
  })

  it("leaves other rows untouched when dismissing one", async () => {
    const key1 = "11".repeat(32)
    const key2 = "22".repeat(32)
    const addr1 = "Address111111111111111111111111111111111111"
    const addr2 = "Address222222222222222222222222222222222222"

    await saveSwapOutput({
      freshAddress: addr1,
      freshSecretKeyHex: key1,
      outputMint: "SOL",
      outAmount: 0,
      swapSignature: "",
      createdAt: 100
    })

    await saveSwapOutput({
      freshAddress: addr2,
      freshSecretKeyHex: key2,
      outputMint: "SOL",
      outAmount: 0,
      swapSignature: "",
      createdAt: 200
    })

    await dismissSwapOutput(addr1)

    const list = await listSwapOutputs()
    const r1 = list.find((o) => o.freshAddress === addr1)
    const r2 = list.find((o) => o.freshAddress === addr2)

    expect(r1?.dismissed).toBe(true)
    expect(r1?.freshSecretKeyHex).toBe(key1)

    expect(r2?.dismissed).toBeUndefined()
    expect(r2?.freshSecretKeyHex).toBe(key2)
  })

  it("handles dismissing a non-existent address gracefully without error or corruption", async () => {
    await dismissSwapOutput("NonExistentAddress")
    const list = await listSwapOutputs()
    expect(list).toEqual([])
  })
})
