import { beforeEach, describe, expect, it } from "vitest"
import {
  dismissSwapOutput,
  listSwapOutputs,
  saveSwapOutput,
  type SwapOutput
} from "../lib/paraloom/swapOutputs"
import { installFakeChrome } from "./support/chromeStorage"

describe("swapOutputs storage", () => {
  beforeEach(() => {
    installFakeChrome()
  })

  it("ignores invalid inputs to saveSwapOutput", async () => {
    await saveSwapOutput(null as unknown as SwapOutput)
    await saveSwapOutput(undefined as unknown as SwapOutput)
    await saveSwapOutput({} as unknown as SwapOutput)
    await saveSwapOutput({ freshAddress: "   " } as unknown as SwapOutput)

    const list = await listSwapOutputs()
    expect(list).toEqual([])
  })

  it("handles corrupted non-array storage gracefully in listSwapOutputs", async () => {
    await chrome.storage.local.set({
      paraloom_swap_outputs: "not-an-array" as unknown as unknown[]
    })
    expect(await listSwapOutputs()).toEqual([])

    await chrome.storage.local.set({
      paraloom_swap_outputs: { foo: "bar" } as unknown as unknown[]
    })
    expect(await listSwapOutputs()).toEqual([])
  })

  it("filters corrupted or null items in listSwapOutputs", async () => {
    await chrome.storage.local.set({
      paraloom_swap_outputs: [
        null,
        123,
        { freshAddress: "" },
        {
          freshAddress: "validAddress",
          outputMint: "SOL",
          outAmount: 1,
          swapSignature: "sig",
          createdAt: 100
        }
      ]
    })
    const list = await listSwapOutputs()
    expect(list.length).toBe(1)
    expect(list[0].freshAddress).toBe("validAddress")
  })

  it("saves a valid swap output with valid createdAt fallback", async () => {
    const item: SwapOutput = {
      freshAddress: "addr1",
      freshSecretKeyHex: "sec1",
      outputMint: "SOL",
      outAmount: 0,
      swapSignature: "",
      reshield: true,
      createdAt: NaN
    }
    await saveSwapOutput(item)
    const list = await listSwapOutputs()
    expect(list.length).toBe(1)
    expect(list[0].freshAddress).toBe("addr1")
    expect(Number.isFinite(list[0].createdAt)).toBe(true)
    expect(list[0].reshield).toBe(true)
  })

  it("preserves createdAt and reshield metadata across updates", async () => {
    const initialCreatedAt = 1700000000000
    await saveSwapOutput({
      freshAddress: "addr2",
      freshSecretKeyHex: "sec2",
      outputMint: "SOL",
      outAmount: 0,
      swapSignature: "",
      reshield: true,
      createdAt: initialCreatedAt
    })

    // Second call simulates privateSwap recording realized amount and signature with fresh createdAt and omitting reshield
    await saveSwapOutput({
      freshAddress: "addr2",
      freshSecretKeyHex: "sec2",
      outputMint: "SOL",
      outAmount: 5000,
      swapSignature: "txSig123",
      createdAt: initialCreatedAt + 60_000
    })

    const list = await listSwapOutputs()
    expect(list.length).toBe(1)
    expect(list[0].freshAddress).toBe("addr2")
    expect(list[0].createdAt).toBe(initialCreatedAt)
    expect(list[0].reshield).toBe(true)
    expect(list[0].swapSignature).toBe("txSig123")
    expect(list[0].outAmount).toBe(5000)
  })

  it("updates reshieldRecovered when explicitly set and preserves it on later updates", async () => {
    await saveSwapOutput({
      freshAddress: "addr3",
      freshSecretKeyHex: "sec3",
      outputMint: "MINT",
      outAmount: 100,
      swapSignature: "sig",
      reshield: true,
      createdAt: 1000
    })

    // Recovery sets reshieldRecovered: true
    await saveSwapOutput({
      freshAddress: "addr3",
      freshSecretKeyHex: "sec3",
      outputMint: "MINT",
      outAmount: 100,
      swapSignature: "sig",
      reshieldRecovered: true,
      createdAt: 1000
    })

    let list = await listSwapOutputs()
    expect(list[0].reshieldRecovered).toBe(true)

    // Subsequent update without reshieldRecovered preserves it
    await saveSwapOutput({
      freshAddress: "addr3",
      freshSecretKeyHex: "sec3",
      outputMint: "MINT",
      outAmount: 200,
      swapSignature: "sig",
      createdAt: 1000
    })

    list = await listSwapOutputs()
    expect(list[0].reshieldRecovered).toBe(true)
    expect(list[0].outAmount).toBe(200)
  })

  it("dismissSwapOutput removes target and handles non-array / empty gracefully", async () => {
    await dismissSwapOutput("")
    await dismissSwapOutput(null as unknown as string)

    await saveSwapOutput({
      freshAddress: "addrA",
      freshSecretKeyHex: "secA",
      outputMint: "SOL",
      outAmount: 0,
      swapSignature: "",
      createdAt: 100
    })
    await saveSwapOutput({
      freshAddress: "addrB",
      freshSecretKeyHex: "secB",
      outputMint: "SOL",
      outAmount: 0,
      swapSignature: "",
      createdAt: 200
    })

    await dismissSwapOutput("addrA")
    const list = await listSwapOutputs()
    expect(list.length).toBe(1)
    expect(list[0].freshAddress).toBe("addrB")
  })
})
