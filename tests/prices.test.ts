import { beforeEach, describe, expect, it, vi } from "vitest"

import { SOL_MINT, fetchPrices } from "../lib/paraloom/prices"

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

describe("fetchPrices", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it("keeps Jupiter decimals so unknown SPL tokens do not fall back to zero", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        [MINT]: { usdPrice: 1, priceChange24h: 0, decimals: 6 },
        [SOL_MINT]: { usdPrice: 100, priceChange24h: 1, decimals: 9 }
      })
    }))
    vi.stubGlobal("fetch", fetchMock)

    const prices = await fetchPrices([MINT])
    expect(prices[MINT]).toEqual({ usdPrice: 1, priceChange24h: 0, decimals: 6 })
    expect(prices[SOL_MINT]).toEqual({ usdPrice: 100, priceChange24h: 1, decimals: 9 })
  })

  it("omits decimals when Jupiter does not provide them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ [MINT]: { usdPrice: 1, priceChange24h: 0 } })
      }))
    )

    const prices = await fetchPrices([MINT])
    expect(prices[MINT]).toEqual({ usdPrice: 1, priceChange24h: 0, decimals: undefined })
  })
})
