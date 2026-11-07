import { fetchPrices, MAX_PRICE_IDS, SOL_MINT } from "~lib/paraloom/prices"
import {
  addApprovedOrigin,
  getApprovedOrigins,
  isOriginApproved,
  isValidOrigin
} from "~lib/storage/connections"
import {
  getAutoLockMinutes,
  MAX_AUTO_LOCK_MINUTES,
  MIN_AUTO_LOCK_MINUTES,
  setAutoLockMinutes
} from "~lib/storage/secure"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ConnectApprove } from "../src/popup/ConnectApprove"
import { formatAmount, inputInfo, SwapApprove, tokenLabel } from "../src/popup/SwapApprove"
import { installFakeChrome } from "./support/chromeStorage"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  v3NotePubkey: vi.fn().mockResolvedValue("mock-pubkey")
}))

describe("SwapApprove formatting", () => {
  const WSOL_MINT = "So11111111111111111111111111111111111111112"

  it("does not round sub-microlamport spends to 0", () => {
    // 1 lamport of SOL (0.000000001) must never round to "0"
    expect(formatAmount("1", 9)).not.toBe("0")
    expect(formatAmount("1", 9)).toBe("0.000000001")

    // 500 lamports (0.0000005 SOL)
    expect(formatAmount("500", 9)).not.toBe("0")
    expect(formatAmount("500", 9)).toBe("0.0000005")

    // 999 lamports
    expect(formatAmount("999", 9)).not.toBe("0")
    expect(formatAmount("999", 9)).toBe("0.000000999")

    // True zero
    expect(formatAmount("0", 9)).toBe("0")
  })

  it("formats WSOL inputs as SOL with 9 decimals instead of raw base units", () => {
    const info = inputInfo(WSOL_MINT)
    expect(info.decimals).toBe(9)
    expect(info.symbol).toBe("SOL")
    expect(tokenLabel(WSOL_MINT)).toBe("SOL")

    // 1 SOL in WSOL
    expect(formatAmount("1000000000", info.decimals)).toBe("1")
  })

  it("renders SwapApprove with accurate sub-microlamport and WSOL text", () => {
    const html = renderToStaticMarkup(
      React.createElement(SwapApprove, {
        id: 1,
        origin: "https://app.paraloom.io",
        params: {
          outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          inputMint: WSOL_MINT,
          amountLamports: "1" // 1 lamport
        },
        onResolved: () => {}
      })
    )

    // Must show 0.000000001 SOL, never "0 SOL" or raw base units
    expect(html).toContain("0.000000001")
    expect(html).toContain("SOL")
    expect(html).not.toContain("0 SOL")
    expect(html).not.toContain("So11…1112")
  })

  it("renders ConnectApprove and SwapApprove buttons enabled initially", () => {
    const connectHtml = renderToStaticMarkup(
      React.createElement(ConnectApprove, {
        id: 2,
        origin: "https://app.paraloom.io",
        onResolved: () => {}
      })
    )
    expect(connectHtml).toContain("Connect wallet")
    expect(connectHtml).not.toContain("disabled")

    const swapHtml = renderToStaticMarkup(
      React.createElement(SwapApprove, {
        id: 3,
        origin: "https://app.paraloom.io",
        params: {
          outputMint: "SOL",
          amountLamports: "1000000"
        },
        onResolved: () => {}
      })
    )
    expect(swapHtml).toContain("Approve private swap")
    expect(swapHtml).not.toContain("disabled")
  })
})

describe("connections.ts opaque origin handling", () => {
  beforeEach(() => {
    installFakeChrome()
  })

  it("isValidOrigin rejects null, empty, and non-http(s) origins", () => {
    expect(isValidOrigin("null")).toBe(false)
    expect(isValidOrigin("NULL")).toBe(false)
    expect(isValidOrigin("")).toBe(false)
    expect(isValidOrigin("   ")).toBe(false)
    expect(isValidOrigin("javascript:alert(1)")).toBe(false)
    expect(isValidOrigin("data:text/html,test")).toBe(false)
    expect(isValidOrigin("about:blank")).toBe(false)

    expect(isValidOrigin("https://app.paraloom.io")).toBe(true)
    expect(isValidOrigin("http://localhost:3000")).toBe(true)
    expect(isValidOrigin("http://127.0.0.1:8080")).toBe(true)
  })

  it("isOriginApproved and addApprovedOrigin reject opaque null origin", async () => {
    await addApprovedOrigin("null")
    await addApprovedOrigin("  ")
    await addApprovedOrigin("https://trusted.app")

    const approved = await getApprovedOrigins()
    expect(approved).toEqual(["https://trusted.app"])
    expect(await isOriginApproved("null")).toBe(false)
    expect(await isOriginApproved("")).toBe(false)
    expect(await isOriginApproved("https://trusted.app")).toBe(true)
  })
})

describe("secure.ts bounds checks", () => {
  beforeEach(() => {
    installFakeChrome()
  })

  it("setAutoLockMinutes rejects out-of-bounds, NaN, and non-finite values", async () => {
    await expect(setAutoLockMinutes(0)).rejects.toThrow(
      "Auto-lock minutes must be a number between"
    )
    await expect(setAutoLockMinutes(-10)).rejects.toThrow(
      "Auto-lock minutes must be a number between"
    )
    await expect(setAutoLockMinutes(NaN)).rejects.toThrow(
      "Auto-lock minutes must be a number between"
    )
    await expect(setAutoLockMinutes(Infinity)).rejects.toThrow(
      "Auto-lock minutes must be a number between"
    )
    await expect(setAutoLockMinutes(-Infinity)).rejects.toThrow(
      "Auto-lock minutes must be a number between"
    )
    await expect(setAutoLockMinutes(MAX_AUTO_LOCK_MINUTES + 1)).rejects.toThrow(
      "Auto-lock minutes must be a number between"
    )
  })

  it("setAutoLockMinutes and getAutoLockMinutes accept valid bounds", async () => {
    // Initialize storage
    await chrome.storage.local.set({ paraloom_wallet: { locked: false, autoLockMinutes: 60 } })

    await setAutoLockMinutes(MIN_AUTO_LOCK_MINUTES)
    expect(await getAutoLockMinutes()).toBe(MIN_AUTO_LOCK_MINUTES)

    await setAutoLockMinutes(30)
    expect(await getAutoLockMinutes()).toBe(30)

    await setAutoLockMinutes(MAX_AUTO_LOCK_MINUTES)
    expect(await getAutoLockMinutes()).toBe(MAX_AUTO_LOCK_MINUTES)
  })

  it("getAutoLockMinutes defaults to 60 if stored value is invalid", async () => {
    await chrome.storage.local.set({ paraloom_wallet: { locked: false, autoLockMinutes: -50 } })
    expect(await getAutoLockMinutes()).toBe(60)

    await chrome.storage.local.set({ paraloom_wallet: { locked: false, autoLockMinutes: NaN } })
    expect(await getAutoLockMinutes()).toBe(60)
  })
})

describe("prices.ts bounds checks", () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("bounds request IDs to MAX_PRICE_IDS (100)", async () => {
    let requestedUrl = ""
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      requestedUrl = url
      return {
        ok: true,
        status: 200,
        json: async () => ({})
      }
    })

    const manyMints = Array.from({ length: 200 }, (_, i) => `Mint${i}`)
    await fetchPrices(manyMints)

    const urlObj = new URL(requestedUrl)
    const ids = urlObj.searchParams.get("ids")?.split(",") ?? []
    expect(ids.length).toBeLessThanOrEqual(MAX_PRICE_IDS)
  })

  it("rejects invalid/negative/infinite usdPrice and sanitizes priceChange24h", async () => {
    global.fetch = vi.fn().mockImplementation(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          [SOL_MINT]: { usdPrice: 150.25, priceChange24h: 3.5 },
          NegativeToken: { usdPrice: -10, priceChange24h: 1 },
          InfinityToken: { usdPrice: Infinity, priceChange24h: 1 },
          NaNToken: { usdPrice: NaN, priceChange24h: 1 },
          HugeToken: { usdPrice: 1e15, priceChange24h: 1 },
          ExtremeLossToken: { usdPrice: 1.0, priceChange24h: -150 }, // < -100%
          ExtremeGainToken: { usdPrice: 1.0, priceChange24h: 1e9 } // > 1e6
        })
      }
    })

    const prices = await fetchPrices([
      "NegativeToken",
      "InfinityToken",
      "NaNToken",
      "HugeToken",
      "ExtremeLossToken",
      "ExtremeGainToken"
    ])

    expect(prices[SOL_MINT]).toEqual({ usdPrice: 150.25, priceChange24h: 3.5 })
    expect(prices["NegativeToken"]).toBeUndefined()
    expect(prices["InfinityToken"]).toBeUndefined()
    expect(prices["NaNToken"]).toBeUndefined()
    expect(prices["HugeToken"]).toBeUndefined()

    // Extreme loss (< -100%) is sanitized to 0
    expect(prices["ExtremeLossToken"]).toEqual({ usdPrice: 1.0, priceChange24h: 0 })
    // Extreme gain (> 1e6) is sanitized to 0
    expect(prices["ExtremeGainToken"]).toEqual({ usdPrice: 1.0, priceChange24h: 0 })

    global.fetch = originalFetch
  })
})
