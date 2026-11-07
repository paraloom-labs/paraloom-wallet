import { describe, expect, it, vi, beforeEach } from "vitest"

// Mock wasm prover so tests don't fail under vitest node environment
vi.mock("~lib/prover", () => ({ NATIVE_ASSET_HEX: "00".repeat(32) }))

import { canonicalizeOrigin, addApprovedOrigin, isOriginApproved, removeApprovedOrigin } from "../lib/storage/connections"
import { getAutoLockMinutes, setAutoLockMinutes, getNetwork, setNetwork } from "../lib/storage/secure"
import { fetchPrices, SOL_MINT } from "../lib/paraloom/prices"
import { formatAmount, tokenLabel, inputInfo } from "../lib/paraloom/amount"

// In-memory mock for chrome.storage.local
const mockStorage: Record<string, unknown> = {}
global.chrome = {
  storage: {
    local: {
      get: vi.fn(async (key: string | string[]) => {
        if (typeof key === "string") {
          return { [key]: mockStorage[key] }
        }
        const res: Record<string, unknown> = {}
        for (const k of key) {
          res[k] = mockStorage[k]
        }
        return res
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(mockStorage, items)
      })
    }
  }
} as unknown as typeof chrome

describe("Issue #248: Origin Isolation & Storage Security", () => {
  beforeEach(() => {
    for (const k of Object.keys(mockStorage)) {
      delete mockStorage[k]
    }
  })

  it("canonicalizeOrigin correctly filters null, non-http, and normalizes hostnames", () => {
    expect(canonicalizeOrigin("null")).toBeNull()
    expect(canonicalizeOrigin("")).toBeNull()
    expect(canonicalizeOrigin("data:text/html,test")).toBeNull()
    expect(canonicalizeOrigin("javascript:alert(1)")).toBeNull()
    expect(canonicalizeOrigin("https://App.Paraloom.io/path/page")).toBe("https://app.paraloom.io")
    expect(canonicalizeOrigin("http://localhost:3000/")).toBe("http://localhost:3000")
  })

  it("addApprovedOrigin and isOriginApproved enforce canonical origins and reject 'null'", async () => {
    await addApprovedOrigin("null")
    expect(await isOriginApproved("null")).toBe(false)

    await addApprovedOrigin("https://App.Paraloom.io/nested/page")
    expect(await isOriginApproved("https://app.paraloom.io")).toBe(true)
    expect(await isOriginApproved("https://App.Paraloom.io/")).toBe(true)

    await removeApprovedOrigin("https://App.Paraloom.io/")
    expect(await isOriginApproved("https://app.paraloom.io")).toBe(false)
  })

  it("autoLockMinutes validation rejects NaN, Infinity, and <= 0", async () => {
    expect(await getAutoLockMinutes()).toBe(60)

    await setAutoLockMinutes(15)
    expect(await getAutoLockMinutes()).toBe(15)

    await setAutoLockMinutes(NaN)
    expect(await getAutoLockMinutes()).toBe(15)

    await setAutoLockMinutes(Infinity)
    expect(await getAutoLockMinutes()).toBe(15)

    await setAutoLockMinutes(0)
    expect(await getAutoLockMinutes()).toBe(15)

    await setAutoLockMinutes(-10)
    expect(await getAutoLockMinutes()).toBe(15)
  })

  it("network validation restricts values to mainnet-beta or devnet", async () => {
    expect(await getNetwork()).toBe("mainnet-beta")

    await setNetwork("devnet")
    expect(await getNetwork()).toBe("devnet")

    // Invalid network strings are rejected
    await setNetwork("custom-net" as any)
    expect(await getNetwork()).toBe("devnet")
  })
})

describe("Issue #248: SwapApprove Exact Precision & WSOL Handling", () => {
  const WSOL_MINT = "So11111111111111111111111111111111111111112"

  it("handles WSOL_MINT in tokenLabel and inputInfo", () => {
    expect(tokenLabel("SOL")).toBe("SOL")
    expect(tokenLabel(WSOL_MINT)).toBe("SOL")
    expect(inputInfo(WSOL_MINT)).toEqual({ decimals: 9, symbol: "SOL" })
  })

  it("formatAmount preserves all decimal precision without 0-rounding", () => {
    // 400 lamports (0.0000004 SOL) was previously rounded to "0 SOL"
    expect(formatAmount("400", 9)).toBe("0.0000004")
    expect(formatAmount("1000000000", 9)).toBe("1")
    expect(formatAmount("1500000000", 9)).toBe("1.5")
    expect(formatAmount("1000000000000000001", 9)).toBe("1,000,000,000.000000001")
    expect(formatAmount("50", 6)).toBe("0.00005")
  })
})

describe("Issue #248: Price API Robustness", () => {
  it("filters and encodes valid mints, rejects invalid/negative prices", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("ids=")
      return {
        ok: true,
        json: async () => ({
          [SOL_MINT]: { usdPrice: 185.50, priceChange24h: 3.2 },
          "invalidMint": { usdPrice: -10, priceChange24h: 0 },
          "nanMint": { usdPrice: NaN }
        })
      }
    })
    global.fetch = fetchMock as any

    const prices = await fetchPrices(["SOL"])
    expect(prices[SOL_MINT]).toBeDefined()
    expect(prices[SOL_MINT].usdPrice).toBe(185.50)
    expect(prices["invalidMint"]).toBeUndefined()
    expect(prices["nanMint"]).toBeUndefined()
  })
})
