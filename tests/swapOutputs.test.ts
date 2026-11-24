import { beforeEach, describe, expect, it } from "vitest"
import {
  dismissSwapOutput,
  listSwapOutputs,
  saveSwapOutput,
  SWAP_OUTPUT_TTL_MS,
  type SwapOutput
} from "~lib/paraloom/swapOutputs"
import {
  installFakeChrome,
  seedUnlockedSession,
  type FakeChrome
} from "./support/chromeStorage"

const SECRET_HEX = "ab".repeat(64)
const FRESH_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"

let chrome: FakeChrome

function sampleSwapOutput(overrides: Partial<SwapOutput> = {}): SwapOutput {
  return {
    freshAddress: FRESH_ADDR,
    freshSecretKeyHex: SECRET_HEX,
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    outAmount: 0,
    swapSignature: "",
    reshield: false,
    createdAt: Date.now(),
    ...overrides
  }
}

beforeEach(async () => {
  chrome = installFakeChrome()
  await seedUnlockedSession(chrome)
})

describe("encrypted swap outputs storage (#298)", () => {
  it("never writes freshSecretKeyHex in plaintext to chrome.storage.local", async () => {
    await saveSwapOutput(sampleSwapOutput())

    const raw = chrome.storage.local.raw["paraloom_swap_outputs"] as Record<string, unknown>
    expect(raw.v).toBe(1)
    expect(typeof raw.nonce).toBe("string")
    expect(typeof raw.ciphertext).toBe("string")
    expect(Array.isArray(raw)).toBe(false)
    expect(JSON.stringify(raw)).not.toContain(SECRET_HEX)
    expect(JSON.stringify(raw)).not.toContain(FRESH_ADDR)
  })

  it("round-trips and upserts swap outputs by freshAddress through the encrypted envelope", async () => {
    await saveSwapOutput(sampleSwapOutput())
    await saveSwapOutput(
      sampleSwapOutput({
        outAmount: 1_500_000,
        swapSignature: "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirB"
      })
    )

    const outputs = await listSwapOutputs()
    expect(outputs).toHaveLength(1)
    expect(outputs[0].freshAddress).toBe(FRESH_ADDR)
    expect(outputs[0].freshSecretKeyHex).toBe(SECRET_HEX)
    expect(outputs[0].outAmount).toBe(1_500_000)
    expect(outputs[0].swapSignature).toBe(
      "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirB"
    )
  })

  it("migrates legacy plaintext swap outputs to the encrypted envelope on first unlocked read", async () => {
    await chrome.storage.local.set({
      paraloom_swap_outputs: [sampleSwapOutput({ outAmount: 2_000_000 })]
    })

    const outputs = await listSwapOutputs()
    expect(outputs).toHaveLength(1)
    expect(outputs[0].freshSecretKeyHex).toBe(SECRET_HEX)

    const raw = chrome.storage.local.raw["paraloom_swap_outputs"] as Record<string, unknown>
    expect(raw.v).toBe(1)
    expect(JSON.stringify(raw)).not.toContain(SECRET_HEX)
  })

  it("refuses to save or read encrypted swap outputs while locked", async () => {
    chrome = installFakeChrome()

    await expect(saveSwapOutput(sampleSwapOutput())).rejects.toThrow(/locked/i)
    expect(chrome.storage.local.raw["paraloom_swap_outputs"]).toBeUndefined()
  })

  it("fails closed on a tampered ciphertext envelope", async () => {
    await saveSwapOutput(sampleSwapOutput())

    const raw = chrome.storage.local.raw["paraloom_swap_outputs"] as Record<string, string>
    const tampered =
      raw.ciphertext.slice(0, -2) + (raw.ciphertext.slice(-2) === "00" ? "ff" : "00")
    await chrome.storage.local.set({
      paraloom_swap_outputs: { ...raw, ciphertext: tampered }
    })

    await expect(listSwapOutputs()).rejects.toThrow(/decrypt/i)
  })

  it("scrubs freshSecretKeyHex once reshieldRecovered is true and garbage-collects expired recovered rows", async () => {
    const now = Date.now()
    await saveSwapOutput(
      sampleSwapOutput({
        reshield: true,
        reshieldRecovered: true,
        swapSignature: "sig-settled",
        createdAt: now
      })
    )
    await saveSwapOutput(
      sampleSwapOutput({
        freshAddress: "ExpiredReshield11111111111111111111111111111",
        reshield: true,
        reshieldRecovered: true,
        swapSignature: "sig-old",
        createdAt: now - SWAP_OUTPUT_TTL_MS - 1_000
      })
    )

    const outputs = await listSwapOutputs()
    expect(outputs).toHaveLength(1)
    expect(outputs[0].freshAddress).toBe(FRESH_ADDR)
    expect(outputs[0].freshSecretKeyHex).toBe("")

    await dismissSwapOutput(FRESH_ADDR)
    expect(await listSwapOutputs()).toHaveLength(0)
  })
})
