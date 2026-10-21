import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({ NATIVE_ASSET_HEX: "00".repeat(32) }))

import { retryingFetch } from "../lib/paraloom/bridge"
import { fetchPrices, SOL_MINT } from "../lib/paraloom/prices"
import { dismissSwapOutput, listSwapOutputs, saveSwapOutput } from "../lib/paraloom/swapOutputs"
import {
  getAutoLockMinutes,
  getNetwork,
  isWalletLocked,
  setAutoLockMinutes,
  setLockState,
  setNetwork
} from "../lib/storage/secure"
import { installFakeChrome } from "./support/chromeStorage"

describe("Concurrency, State Resilience & Prices", () => {
  beforeEach(() => {
    installFakeChrome()
    vi.restoreAllMocks()
  })

  describe("swapOutputs non-destructive merge & serialization", () => {
    it("preserves freshSecretKeyHex when a later write omits or empties it", async () => {
      const address = "FreshAddr111111111111111111111111111111111"
      const secret = "deadbeefcafebabe0123456789abcdef"

      await saveSwapOutput({
        freshAddress: address,
        freshSecretKeyHex: secret,
        outputMint: "SOL",
        outAmount: 0,
        swapSignature: "",
        reshield: true,
        createdAt: 1000
      })

      // Simulate a racing/stale write that lacked secret key
      await saveSwapOutput({
        freshAddress: address,
        freshSecretKeyHex: "",
        outputMint: "SOL",
        outAmount: 5000000,
        swapSignature: "sig123456",
        createdAt: 1000
      })

      const outputs = await listSwapOutputs()
      expect(outputs).toHaveLength(1)
      expect(outputs[0].freshSecretKeyHex).toBe(secret)
      expect(outputs[0].swapSignature).toBe("sig123456")
      expect(outputs[0].outAmount).toBe(5000000)
      expect(outputs[0].reshield).toBe(true)
    })

    it("preserves positive outAmount, swapSignature and reshieldRecovered from clobbering", async () => {
      const address = "FreshAddr222222222222222222222222222222222"

      await saveSwapOutput({
        freshAddress: address,
        freshSecretKeyHex: "sec001",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        outAmount: 10000000,
        swapSignature: "txConfirmedSignature",
        reshield: true,
        reshieldRecovered: true,
        createdAt: 2000
      })

      // Delayed write with 0 amount and empty signature
      await saveSwapOutput({
        freshAddress: address,
        freshSecretKeyHex: "",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        outAmount: 0,
        swapSignature: "",
        createdAt: 2000
      })

      const outputs = await listSwapOutputs()
      expect(outputs).toHaveLength(1)
      expect(outputs[0].outAmount).toBe(10000000)
      expect(outputs[0].swapSignature).toBe("txConfirmedSignature")
      expect(outputs[0].reshieldRecovered).toBe(true)
    })

    it("handles concurrent writes to different outputs without data loss", async () => {
      const writes = Array.from({ length: 10 }, (_, i) =>
        saveSwapOutput({
          freshAddress: `Addr_${i}`,
          freshSecretKeyHex: `Key_${i}`,
          outputMint: "SOL",
          outAmount: i * 100,
          swapSignature: `sig_${i}`,
          createdAt: Date.now()
        })
      )

      await Promise.all(writes)
      const outputs = await listSwapOutputs()
      expect(outputs).toHaveLength(10)

      await dismissSwapOutput("Addr_3")
      const remaining = await listSwapOutputs()
      expect(remaining).toHaveLength(9)
      expect(remaining.find((o) => o.freshAddress === "Addr_3")).toBeUndefined()
    })
  })

  describe("secure wallet storage serialization", () => {
    it("serializes concurrent wallet storage mutators without lost updates", async () => {
      // Initialize storage with a baseline wallet structure
      const chromeStorage = (globalThis as unknown as { chrome: { storage: { local: { set: (v: any) => Promise<void> } } } }).chrome
      await chromeStorage.storage.local.set({
        paraloom_wallet: {
          wallet: { address: "addr1", encryptedData: {} as any, createdAt: 1, kdfVersion: "scrypt" },
          locked: true,
          autoLockMinutes: 15,
          network: "mainnet-beta"
        }
      })

      // Concurrently fire mutators
      await Promise.all([
        setLockState(false),
        setAutoLockMinutes(30),
        setNetwork("devnet")
      ])

      expect(await isWalletLocked()).toBe(false)
      expect(await getAutoLockMinutes()).toBe(30)
      expect(await getNetwork()).toBe("devnet")
    })
  })

  describe("retryingFetch 429 and 408 resilience", () => {
    it("retries HTTP 429 and succeeds on subsequent attempt", async () => {
      let callCount = 0
      const fakeFetch = vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return new Response("Too Many Requests", {
            status: 429,
            headers: { "Retry-After": "0.01" }
          })
        }
        return new Response(JSON.stringify({ result: "ok" }), { status: 200 })
      })

      globalThis.fetch = fakeFetch
      const res = await retryingFetch("https://node.paraloom.io/rpc")
      expect(res.status).toBe(200)
      expect(callCount).toBe(2)
    })

    it("retries HTTP 408 request timeout", async () => {
      let callCount = 0
      const fakeFetch = vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return new Response("Request Timeout", { status: 408 })
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      })

      globalThis.fetch = fakeFetch
      const res = await retryingFetch("https://node.paraloom.io/rpc")
      expect(res.status).toBe(200)
      expect(callCount).toBe(2)
    })

    it("returns 400 or 404 client errors immediately without retrying", async () => {
      let callCount = 0
      const fakeFetch = vi.fn().mockImplementation(async () => {
        callCount++
        return new Response("Bad Request", { status: 400 })
      })

      globalThis.fetch = fakeFetch
      const res = await retryingFetch("https://node.paraloom.io/rpc")
      expect(res.status).toBe(400)
      expect(callCount).toBe(1)
    })
  })

  describe("fetchPrices validation & URL encoding", () => {
    it("filters out NaN, Infinity, and negative prices", async () => {
      const mockPrices = {
        [SOL_MINT]: { usdPrice: 150.25, priceChange24h: 2.5 },
        "BadMintNaN": { usdPrice: NaN, priceChange24h: 1.0 },
        "BadMintInfinity": { usdPrice: Infinity, priceChange24h: 0 },
        "BadMintNegative": { usdPrice: -10, priceChange24h: -5 },
        "ValidSplMint": { usdPrice: 1.0, priceChange24h: NaN }
      }

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockPrices
      }) as unknown as typeof fetch

      const prices = await fetchPrices(["BadMintNaN", "BadMintInfinity", "BadMintNegative", "ValidSplMint"])

      expect(prices[SOL_MINT]).toBeDefined()
      expect(prices[SOL_MINT].usdPrice).toBe(150.25)
      expect(prices["BadMintNaN"]).toBeUndefined()
      expect(prices["BadMintInfinity"]).toBeUndefined()
      expect(prices["BadMintNegative"]).toBeUndefined()
      expect(prices["ValidSplMint"]).toBeDefined()
      expect(prices["ValidSplMint"].usdPrice).toBe(1.0)
      // Non-finite change defaults to 0
      expect(prices["ValidSplMint"].priceChange24h).toBe(0)
    })

    it("URL-encodes mint identifiers", async () => {
      let requestedUrl = ""
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        requestedUrl = url
        return {
          ok: true,
          json: async () => ({})
        }
      }) as unknown as typeof fetch

      await fetchPrices(["Token+With/Special=Chars"])
      expect(requestedUrl).toContain(encodeURIComponent("Token+With/Special=Chars"))
    })
  })
})
