import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

import { fetchPrices, SOL_MINT } from "../lib/paraloom/prices"

describe("prices and decimals handling (#140)", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("captures decimals from Jupiter Price API v3 response", async () => {
    const mockResponse = {
      [SOL_MINT]: { usdPrice: 150.25, priceChange24h: 2.5, decimals: 9 },
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": {
        usdPrice: 1.0,
        priceChange24h: 0.01,
        decimals: 6
      },
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": {
        usdPrice: 0.000025,
        priceChange24h: -1.2,
        decimals: 5
      }
    }

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse
    }) as never

    const prices = await fetchPrices([
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
    ])

    expect(prices[SOL_MINT]?.decimals).toBe(9)
    expect(prices["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]?.decimals).toBe(6)
    expect(prices["DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"]?.decimals).toBe(5)
    expect(prices[SOL_MINT]?.usdPrice).toBe(150.25)
  })

  it("handles responses where decimals field is omitted gracefully", async () => {
    const mockResponse = {
      [SOL_MINT]: { usdPrice: 150.25, priceChange24h: 2.5 }
    }

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse
    }) as never

    const prices = await fetchPrices([])
    expect(prices[SOL_MINT]?.decimals).toBeUndefined()
    expect(prices[SOL_MINT]?.usdPrice).toBe(150.25)
  })
})
