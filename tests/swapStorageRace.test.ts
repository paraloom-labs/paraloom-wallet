import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({
  assetIdForMint: vi.fn(async () => "00".repeat(32)),
  v3NoteCommitment: vi.fn(async () => "c0"),
  v3NoteCommitmentAsset: vi.fn(async () => "c0@asset"),
  v3NotePubkey: vi.fn(async () => "pub_test"),
  NATIVE_ASSET_HEX: "00".repeat(32)
}))

import { installFakeChrome } from "./support/chromeStorage"
import {
  dismissSwapOutput,
  listSwapOutputs,
  saveSwapOutput,
  type SwapOutput
} from "~lib/paraloom/swapOutputs"
import { fetchPrices } from "~lib/paraloom/prices"
import { retryingFetch } from "~lib/paraloom/bridge"
import {
  getAutoLockMinutes,
  getNetwork,
  isWalletLocked,
  setAutoLockMinutes,
  setLockState,
  setNetwork
} from "~lib/storage/secure"
import { withExclusiveLock, withNonBlockingLock } from "~lib/storage/locks"

beforeEach(() => {
  installFakeChrome()
})

describe("Swap Output Non-Destructive Storage Merging", () => {
  it("preserves freshSecretKeyHex when a later stale write lacks it", async () => {
    const freshAddress = "freshAddr111"
    const original: SwapOutput = {
      freshAddress,
      freshSecretKeyHex: "deadbeefcafe",
      outputMint: "SOL",
      outAmount: 0,
      swapSignature: "",
      createdAt: 1000
    }
    await saveSwapOutput(original)

    // Stale caller writes an empty secret key
    const stale: SwapOutput = {
      freshAddress,
      freshSecretKeyHex: "",
      outputMint: "SOL",
      outAmount: 500,
      swapSignature: "sig123",
      createdAt: 1000
    }
    await saveSwapOutput(stale)

    const outputs = await listSwapOutputs()
    expect(outputs).toHaveLength(1)
    expect(outputs[0].freshSecretKeyHex).toBe("deadbeefcafe")
    expect(outputs[0].swapSignature).toBe("sig123")
    expect(outputs[0].outAmount).toBe(500)
  })

  it("does not overwrite an already recorded swapSignature or positive outAmount with empty/zero values", async () => {
    const freshAddress = "freshAddr222"
    await saveSwapOutput({
      freshAddress,
      freshSecretKeyHex: "secretKey222",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outAmount: 1_000_000,
      swapSignature: "validTxSignature456",
      reshield: true,
      createdAt: 2000
    })

    // Stale write with swapSignature: "" and outAmount: 0
    await saveSwapOutput({
      freshAddress,
      freshSecretKeyHex: "secretKey222",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outAmount: 0,
      swapSignature: "",
      createdAt: 2000
    })

    const outputs = await listSwapOutputs()
    expect(outputs[0].swapSignature).toBe("validTxSignature456")
    expect(outputs[0].outAmount).toBe(1_000_000)
    expect(outputs[0].reshield).toBe(true)
  })

  it("preserves reshield: true and reshieldRecovered: true flags across updates", async () => {
    const freshAddress = "freshAddr333"
    await saveSwapOutput({
      freshAddress,
      freshSecretKeyHex: "secretKey333",
      outputMint: "MINT_X",
      outAmount: 100,
      swapSignature: "sig789",
      reshield: true,
      reshieldRecovered: true,
      createdAt: 3000
    })

    // Update with reshield: false and reshieldRecovered: undefined
    await saveSwapOutput({
      freshAddress,
      freshSecretKeyHex: "secretKey333",
      outputMint: "MINT_X",
      outAmount: 100,
      swapSignature: "sig789",
      reshield: false,
      createdAt: 3000
    })

    const outputs = await listSwapOutputs()
    expect(outputs[0].reshield).toBe(true)
    expect(outputs[0].reshieldRecovered).toBe(true)
  })

  it("serializes concurrent saveSwapOutput and dismissSwapOutput without lost writes", async () => {
    const promises: Promise<void>[] = []
    for (let i = 0; i < 10; i++) {
      promises.push(
        saveSwapOutput({
          freshAddress: `addr_${i}`,
          freshSecretKeyHex: `key_${i}`,
          outputMint: "SOL",
          outAmount: i * 10,
          swapSignature: `sig_${i}`,
          createdAt: Date.now()
        })
      )
    }
    await Promise.all(promises)

    const outputs = await listSwapOutputs()
    expect(outputs).toHaveLength(10)

    // Dismiss 3 in parallel while saving 2 new ones
    await Promise.all([
      dismissSwapOutput("addr_2"),
      dismissSwapOutput("addr_5"),
      dismissSwapOutput("addr_8"),
      saveSwapOutput({
        freshAddress: "addr_new_1",
        freshSecretKeyHex: "key_new_1",
        outputMint: "SOL",
        outAmount: 999,
        swapSignature: "sig_new_1",
        createdAt: Date.now()
      }),
      saveSwapOutput({
        freshAddress: "addr_new_2",
        freshSecretKeyHex: "key_new_2",
        outputMint: "SOL",
        outAmount: 888,
        swapSignature: "sig_new_2",
        createdAt: Date.now()
      })
    ])

    const afterOutputs = await listSwapOutputs()
    expect(afterOutputs).toHaveLength(9)
    expect(afterOutputs.map((o) => o.freshAddress)).not.toContain("addr_2")
    expect(afterOutputs.map((o) => o.freshAddress)).not.toContain("addr_5")
    expect(afterOutputs.map((o) => o.freshAddress)).not.toContain("addr_8")
    expect(afterOutputs.map((o) => o.freshAddress)).toContain("addr_new_1")
    expect(afterOutputs.map((o) => o.freshAddress)).toContain("addr_new_2")
  })
})

describe("Wallet Storage Lock Serialization", () => {
  it("serializes concurrent mutations on paraloom_wallet without clobbering", async () => {
    // Initial state
    await chrome.storage.local.set({
      paraloom_wallet: {
        locked: true,
        autoLockMinutes: 60,
        network: "mainnet-beta"
      }
    })

    // Concurrent mutations
    await Promise.all([
      setLockState(false),
      setAutoLockMinutes(15),
      setNetwork("devnet")
    ])

    expect(await isWalletLocked()).toBe(false)
    expect(await getAutoLockMinutes()).toBe(15)
    expect(await getNetwork()).toBe("devnet")
  })
})

describe("Price Sanitation and Encoding in fetchPrices", () => {
  it("filters out NaN, Infinity, and negative prices while handling priceChange24h", async () => {
    const mockData = {
      So11111111111111111111111111111111111111112: {
        usdPrice: 150.25,
        priceChange24h: 3.5
      },
      validToken: {
        usdPrice: 1.0,
        priceChange24h: null
      },
      nanToken: {
        usdPrice: NaN,
        priceChange24h: 2.0
      },
      infinityToken: {
        usdPrice: Infinity,
        priceChange24h: 1.0
      },
      negativeToken: {
        usdPrice: -5.0,
        priceChange24h: -1.0
      }
    }

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockData
    }) as any

    try {
      const prices = await fetchPrices([
        "validToken",
        "nanToken",
        "infinityToken",
        "negativeToken",
        "slash/token?id=1"
      ])

      expect(prices["So11111111111111111111111111111111111111112"]?.usdPrice).toBe(150.25)
      expect(prices["validToken"]?.usdPrice).toBe(1.0)
      expect(prices["validToken"]?.priceChange24h).toBe(0)
      expect(prices["nanToken"]).toBeUndefined()
      expect(prices["infinityToken"]).toBeUndefined()
      expect(prices["negativeToken"]).toBeUndefined()

      // Ensure fetch URL encoded tokens properly
      const calledUrl = (globalThis.fetch as any).mock.calls[0][0] as string
      expect(calledUrl).toContain(encodeURIComponent("slash/token?id=1"))
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("retryingFetch with HTTP 429 / 408", () => {
  it("retries on HTTP 429 and honors Retry-After header", async () => {
    let callCount = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount < 2) {
        return {
          status: 429,
          headers: new Headers({ "retry-after": "0.01" })
        }
      }
      return {
        status: 200,
        ok: true
      }
    }) as any

    try {
      const res = await retryingFetch("https://rpc.example.com")
      expect(res.status).toBe(200)
      expect(callCount).toBe(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("retries on HTTP 408 Request Timeout", async () => {
    let callCount = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount < 2) {
        return {
          status: 408
        }
      }
      return {
        status: 200,
        ok: true
      }
    }) as any

    try {
      const res = await retryingFetch("https://rpc.example.com")
      expect(res.status).toBe(200)
      expect(callCount).toBe(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("Locks Utility", () => {
  it("withNonBlockingLock skips duplicate execution when lock is held", async () => {
    let active = false
    let doubleEntered = false

    const task = async () => {
      if (active) doubleEntered = true
      active = true
      await new Promise((r) => setTimeout(r, 50))
      active = false
      return "done"
    }

    const [res1, res2] = await Promise.all([
      withNonBlockingLock("test_lock", task, () => "busy"),
      withNonBlockingLock("test_lock", task, () => "busy")
    ])

    expect(doubleEntered).toBe(false)
    expect([res1, res2]).toContain("done")
    expect([res1, res2]).toContain("busy")
  })
})
