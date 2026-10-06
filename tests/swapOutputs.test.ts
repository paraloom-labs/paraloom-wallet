import {
  dismissSwapOutput,
  listSwapOutputs,
  saveSwapOutput,
  type SwapOutput
} from "../lib/paraloom/swapOutputs"
import { beforeEach, describe, expect, it } from "vitest"
import { installFakeChrome } from "./support/chromeStorage"

const MOCK_OUTPUT: SwapOutput = {
  freshAddress: "test-address",
  freshSecretKeyHex: "deadbeef",
  outputMint: "SOL",
  outAmount: 100,
  swapSignature: "",
  createdAt: 1000,
}

describe("swapOutputs", () => {
  beforeEach(() => {
    installFakeChrome()
  })

  it("saveSwapOutput adds a new output", async () => {
    await saveSwapOutput(MOCK_OUTPUT)
    const list = await listSwapOutputs()
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual(MOCK_OUTPUT)
  })

  it("dismissSwapOutput marks it dismissed but doesn't delete it or the key", async () => {
    await saveSwapOutput(MOCK_OUTPUT)
    await dismissSwapOutput(MOCK_OUTPUT.freshAddress)

    // We expect listSwapOutputs to hide dismissed outputs
    const activeList = await listSwapOutputs()
    expect(activeList).toHaveLength(0)

    // But the raw storage should still have the output with its secret key
    const rawStorage = await chrome.storage.local.get("paraloom_swap_outputs")
    const rawList = rawStorage["paraloom_swap_outputs"] as SwapOutput[]
    expect(rawList).toHaveLength(1)
    expect(rawList[0].freshSecretKeyHex).toBe("deadbeef")
    expect(rawList[0].dismissed).toBe(true)
  })
})
