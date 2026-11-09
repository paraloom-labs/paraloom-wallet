import { beforeEach, describe, expect, it } from "vitest"
import {
  dismissSwapOutput,
  listSwapOutputs,
  saveSwapOutput,
  type SwapOutput
} from "../lib/paraloom/swapOutputs"
import { installFakeChrome, type FakeChrome } from "./support/chromeStorage"

const KEY = "paraloom_swap_outputs"

describe("swapOutputs", () => {
  let fakeChrome: FakeChrome

  beforeEach(() => {
    fakeChrome = installFakeChrome()
  })

  it("handles non-array storage values gracefully (#264)", async () => {
    await fakeChrome.storage.local.set({ [KEY]: "not an array" })
    expect(await listSwapOutputs()).toEqual([])

    await fakeChrome.storage.local.set({ [KEY]: { some: "object" } })
    expect(await listSwapOutputs()).toEqual([])

    // dismissSwapOutput should not crash when storage has non-array value
    await dismissSwapOutput("addr1")
    expect(await listSwapOutputs()).toEqual([])
  })

  it("validates input fields on saveSwapOutput (#264)", async () => {
    await expect(saveSwapOutput(null as any)).rejects.toThrow("Invalid swap output")
    await expect(saveSwapOutput("not an object" as any)).rejects.toThrow("Invalid swap output")

    await expect(
      saveSwapOutput({
        freshAddress: "",
        freshSecretKeyHex: "aabbcc",
        outputMint: "SOL",
        outAmount: 100,
        swapSignature: "",
        createdAt: 100
      })
    ).rejects.toThrow("Invalid freshAddress")

    await expect(
      saveSwapOutput({
        freshAddress: "   ",
        freshSecretKeyHex: "aabbcc",
        outputMint: "SOL",
        outAmount: 100,
        swapSignature: "",
        createdAt: 100
      })
    ).rejects.toThrow("Invalid freshAddress")

    await expect(
      saveSwapOutput({
        freshAddress: "addr1",
        freshSecretKeyHex: "",
        outputMint: "SOL",
        outAmount: 100,
        swapSignature: "",
        createdAt: 100
      })
    ).rejects.toThrow("Invalid freshSecretKeyHex")

    await expect(
      saveSwapOutput({
        freshAddress: "addr1",
        freshSecretKeyHex: "aabbcc",
        outputMint: "SOL",
        outAmount: Number.NaN,
        swapSignature: "",
        createdAt: 100
      })
    ).rejects.toThrow("Invalid outAmount")

    await expect(
      saveSwapOutput({
        freshAddress: "addr1",
        freshSecretKeyHex: "aabbcc",
        outputMint: "SOL",
        outAmount: -1,
        swapSignature: "",
        createdAt: 100
      })
    ).rejects.toThrow("Invalid outAmount")

    await expect(
      saveSwapOutput({
        freshAddress: "addr1",
        freshSecretKeyHex: "aabbcc",
        outputMint: "SOL",
        outAmount: Number.POSITIVE_INFINITY,
        swapSignature: "",
        createdAt: 100
      })
    ).rejects.toThrow("Invalid outAmount")
  })

  it("inserts new output and trims freshAddress / freshSecretKeyHex", async () => {
    const output: SwapOutput = {
      freshAddress: "  addr1  ",
      freshSecretKeyHex: "  aabbcc  ",
      outputMint: "SOL",
      outAmount: 0,
      swapSignature: "",
      reshield: true,
      createdAt: 1000
    }
    await saveSwapOutput(output)

    const list = await listSwapOutputs()
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual({
      freshAddress: "addr1",
      freshSecretKeyHex: "aabbcc",
      outputMint: "SOL",
      outAmount: 0,
      swapSignature: "",
      reshield: true,
      createdAt: 1000
    })
  })

  it("preserves createdAt, freshSecretKeyHex, and reshield metadata on upsert (#264)", async () => {
    // Initial stage save
    await saveSwapOutput({
      freshAddress: "addr1",
      freshSecretKeyHex: "key123",
      outputMint: "SOL",
      outAmount: 0,
      swapSignature: "",
      reshield: true,
      reshieldRecovered: false,
      createdAt: 1000
    })

    // Second stage save (omits reshield, overwrites createdAt, provides realize outAmount & signature)
    await saveSwapOutput({
      freshAddress: "addr1",
      freshSecretKeyHex: "", // empty secret key should fallback to existing
      outputMint: "SOL",
      outAmount: 500,
      swapSignature: "sig123",
      createdAt: 9999
    } as any)

    let list = await listSwapOutputs()
    expect(list).toHaveLength(1)
    expect(list[0].freshAddress).toBe("addr1")
    expect(list[0].freshSecretKeyHex).toBe("key123")
    expect(list[0].createdAt).toBe(1000) // Preserved!
    expect(list[0].reshield).toBe(true) // Preserved!
    expect(list[0].reshieldRecovered).toBe(false)
    expect(list[0].outAmount).toBe(500)
    expect(list[0].swapSignature).toBe("sig123")

    // Third stage: update reshieldRecovered
    await saveSwapOutput({
      ...list[0],
      reshieldRecovered: true
    })

    list = await listSwapOutputs()
    expect(list).toHaveLength(1)
    expect(list[0].reshieldRecovered).toBe(true)
    expect(list[0].reshield).toBe(true)
    expect(list[0].createdAt).toBe(1000)
  })

  it("dismisses output by fresh address", async () => {
    await saveSwapOutput({
      freshAddress: "addr1",
      freshSecretKeyHex: "key1",
      outputMint: "SOL",
      outAmount: 10,
      swapSignature: "sig1",
      createdAt: 100
    })
    await saveSwapOutput({
      freshAddress: "addr2",
      freshSecretKeyHex: "key2",
      outputMint: "SOL",
      outAmount: 20,
      swapSignature: "sig2",
      createdAt: 200
    })

    expect(await listSwapOutputs()).toHaveLength(2)

    await dismissSwapOutput("addr1")
    const list = await listSwapOutputs()
    expect(list).toHaveLength(1)
    expect(list[0].freshAddress).toBe("addr2")
  })
})
