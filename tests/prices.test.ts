import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  CANONICAL_PRICE_MINTS,
  fetchPrices,
  getSafePriceQueryMints,
  SOL_MINT,
  USDC_MINT
} from "~lib/paraloom/prices"

describe("fetchPrices shielded holdings privacy & robustness (#1577)", () => {
  const originalFetch = globalThis.fetch
  let capturedUrls: string[] = []

  beforeEach(() => {
    capturedUrls = []
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it("returns canonical public mints by default when mint set is empty", () => {
    const mints = getSafePriceQueryMints([])
    expect(mints).toEqual([SOL_MINT, USDC_MINT])
  })

  it("does not leak arbitrary shielded SPL mints when optIn is false (default)", () => {
    const rareShieldedMint = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"
    const mints = getSafePriceQueryMints([rareShieldedMint], false)

    expect(mints).toEqual(Array.from(CANONICAL_PRICE_MINTS))
    expect(mints).not.toContain(rareShieldedMint)
  })

  it("produces invariant query URL regardless of held shielded tokens (fixes holdings leak)", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrls.push(url)
      return {
        ok: true,
        json: async () => ({
          [SOL_MINT]: { usdPrice: 180.5, priceChange24h: 2.1 },
          [USDC_MINT]: { usdPrice: 1.0, priceChange24h: 0.0 }
        })
      }
    })

    const rareMint1 = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"
    const rareMint2 = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"

    // Call 1: empty holdings
    await fetchPrices([])
    // Call 2: holding rare mint 1
    await fetchPrices([rareMint1])
    // Call 3: holding multiple rare mints
    await fetchPrices([rareMint1, rareMint2])

    expect(capturedUrls.length).toBe(3)
    // All 3 requests should be identical and not leak any user-held rare mints
    expect(capturedUrls[0]).toBe(capturedUrls[1])
    expect(capturedUrls[1]).toBe(capturedUrls[2])
    expect(capturedUrls[0]).toContain(encodeURIComponent(SOL_MINT))
    expect(capturedUrls[0]).toContain(encodeURIComponent(USDC_MINT))
    expect(capturedUrls[0]).not.toContain(rareMint1)
    expect(capturedUrls[0]).not.toContain(rareMint2)
  })

  it("allows querying requested mints only when explicit optIn is true", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrls.push(url)
      return {
        ok: true,
        json: async () => ({})
      }
    })

    const customMint = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"
    await fetchPrices([customMint], { optIn: true })

    expect(capturedUrls.length).toBe(1)
    expect(capturedUrls[0]).toContain(customMint)
    expect(capturedUrls[0]).toContain(encodeURIComponent(SOL_MINT))
  })

  it("filters out invalid/poisoned mint strings in optIn mode", () => {
    const validMint = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"
    const invalidMints = ["<script>", "not-base-58!!!", "", "short", "a".repeat(100)]
    const result = getSafePriceQueryMints([...invalidMints, validMint], true)

    expect(result).toContain(validMint)
    expect(result).not.toContain("<script>")
    expect(result).not.toContain("not-base-58!!!")
  })

  it("parses valid price payloads and ignores NaN/negative prices", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return {
        ok: true,
        json: async () => ({
          [SOL_MINT]: { usdPrice: 195.2, priceChange24h: -1.5 },
          [USDC_MINT]: { usdPrice: 1.0, priceChange24h: 0.0 },
          invalidMint1: { usdPrice: NaN, priceChange24h: 0 },
          invalidMint2: { usdPrice: -10, priceChange24h: 0 },
          invalidMint3: { usdPrice: Infinity, priceChange24h: 0 }
        })
      }
    })

    const prices = await fetchPrices([])
    expect(prices[SOL_MINT]).toEqual({ usdPrice: 195.2, priceChange24h: -1.5 })
    expect(prices[USDC_MINT]).toEqual({ usdPrice: 1.0, priceChange24h: 0.0 })
    expect(prices["invalidMint1"]).toBeUndefined()
    expect(prices["invalidMint2"]).toBeUndefined()
    expect(prices["invalidMint3"]).toBeUndefined()
  })

  it("returns empty object on fetch failure without throwing", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network offline"))
    const prices = await fetchPrices([])
    expect(prices).toEqual({})
  })
})
