import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({ NATIVE_ASSET_HEX: "00".repeat(32) }))
vi.mock("data-base64:~/../assets/icon.png", () => ({ default: "test-icon" }))

import {
  formatAmount,
  inputInfo,
  tokenLabel,
  WSOL_MINT
} from "../src/popup/SwapApprove"
import {
  addApprovedOrigin,
  canonicalizeOrigin,
  getApprovedOrigins,
  isOriginApproved,
  removeApprovedOrigin
} from "../lib/storage/connections"
import {
  getAutoLockMinutes,
  getNetwork,
  setAutoLockMinutes,
  setNetwork
} from "../lib/storage/secure"
import { fetchPrices, SOL_MINT } from "../lib/paraloom/prices"
import { installFakeChrome } from "./support/chromeStorage"

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

describe("SwapApprove formatting and mint resolution (#248)", () => {
  it("formats sub-microlamport amounts without rounding to 0", () => {
    // 400 lamports = 0.0000004 SOL (9 decimals)
    expect(formatAmount("400", 9)).toBe("0.0000004")
    // 1 lamport = 0.000000001 SOL
    expect(formatAmount("1", 9)).toBe("0.000000001")
  })

  it("preserves all decimal places without 6-decimal rounding", () => {
    // 1.000000001 SOL
    expect(formatAmount("1000000001", 9)).toBe("1.000000001")
    // 1.5 SOL
    expect(formatAmount("1500000000", 9)).toBe("1.5")
    // Exact zero
    expect(formatAmount("0", 9)).toBe("0")
  })

  it("formats large u64 amounts without IEEE-754 precision loss", () => {
    // u64 MAX = 18446744073709551615
    const u64Max = "18446744073709551615"
    expect(formatAmount(u64Max, 0)).toBe("18,446,744,073,709,551,615")
    expect(formatAmount(u64Max, 6)).toBe("18,446,744,073,709.551615")
  })

  it("rejects negative strings and invalid characters by returning 0", () => {
    expect(formatAmount("-1000", 9)).toBe("0")
    expect(formatAmount("abc", 9)).toBe("0")
    expect(formatAmount("", 9)).toBe("0")
    expect(formatAmount("  ", 9)).toBe("0")
  })

  it("resolves WSOL_MINT correctly in tokenLabel and inputInfo", () => {
    expect(tokenLabel("SOL")).toBe("SOL")
    expect(tokenLabel(WSOL_MINT)).toBe("SOL")
    expect(tokenLabel(USDC_MINT)).toBe("USDC")

    expect(inputInfo(undefined)).toEqual({ decimals: 9, symbol: "SOL" })
    expect(inputInfo("SOL")).toEqual({ decimals: 9, symbol: "SOL" })
    expect(inputInfo(WSOL_MINT)).toEqual({ decimals: 9, symbol: "SOL" })
    expect(inputInfo(USDC_MINT)).toEqual({ decimals: 6, symbol: "USDC" })
  })
})

describe("connections storage and origin canonicalization (#248)", () => {
  beforeEach(() => {
    installFakeChrome()
  })

  it("canonicalizeOrigin handles HTTP/HTTPS and rejects opaque or malformed origins", () => {
    expect(canonicalizeOrigin("https://App.Paraloom.IO/")).toBe("https://app.paraloom.io")
    expect(canonicalizeOrigin("https://app.paraloom.io/sub/path?query=1")).toBe(
      "https://app.paraloom.io"
    )
    expect(canonicalizeOrigin("http://localhost:3000/")).toBe("http://localhost:3000")

    // Disallowed / opaque origins
    expect(canonicalizeOrigin("null")).toBeNull()
    expect(canonicalizeOrigin("file:///etc/passwd")).toBeNull()
    expect(canonicalizeOrigin("data:text/html,test")).toBeNull()
    expect(canonicalizeOrigin("javascript:alert(1)")).toBeNull()
    expect(canonicalizeOrigin("not a url")).toBeNull()
    expect(canonicalizeOrigin("")).toBeNull()
  })

  it("adds, checks, and removes canonical origins", () => {
    return (async () => {
      await addApprovedOrigin("https://App.Paraloom.IO/")
      expect(await isOriginApproved("https://app.paraloom.io")).toBe(true)
      expect(await isOriginApproved("https://App.Paraloom.IO/test")).toBe(true)
      expect(await isOriginApproved("null")).toBe(false)

      // Removing with trailing slash canonicalizes and removes the entry
      await removeApprovedOrigin("https://app.paraloom.io/")
      expect(await isOriginApproved("https://app.paraloom.io")).toBe(false)
    })()
  })

  it("throws when adding invalid or disallowed origins", () => {
    return (async () => {
      await expect(addApprovedOrigin("null")).rejects.toThrow("Invalid or disallowed origin")
      await expect(addApprovedOrigin("file:///tmp/secret")).rejects.toThrow(
        "Invalid or disallowed origin"
      )
      await expect(addApprovedOrigin("")).rejects.toThrow("Invalid or disallowed origin")
    })()
  })
})

describe("secure storage bounds (#248)", () => {
  beforeEach(async () => {
    const fake = installFakeChrome()
    // Pre-populate storage object as saveEncryptedWallet would
    await fake.storage.local.set({
      paraloom_wallet: {
        locked: false,
        autoLockMinutes: 60,
        network: "mainnet-beta"
      }
    })
  })

  it("validates autoLockMinutes bounds", () => {
    return (async () => {
      expect(await getAutoLockMinutes()).toBe(60)

      await setAutoLockMinutes(15)
      expect(await getAutoLockMinutes()).toBe(15)

      await expect(setAutoLockMinutes(0)).rejects.toThrow("Invalid autoLockMinutes")
      await expect(setAutoLockMinutes(-10)).rejects.toThrow("Invalid autoLockMinutes")
      await expect(setAutoLockMinutes(NaN)).rejects.toThrow("Invalid autoLockMinutes")
      await expect(setAutoLockMinutes(Infinity)).rejects.toThrow("Invalid autoLockMinutes")
    })()
  })

  it("validates network bounds", () => {
    return (async () => {
      expect(await getNetwork()).toBe("mainnet-beta")

      await setNetwork("devnet")
      expect(await getNetwork()).toBe("devnet")

      // @ts-expect-error Testing invalid runtime value
      await expect(setNetwork("testnet")).rejects.toThrow("Invalid network")
      // @ts-expect-error Testing invalid runtime value
      await expect(setNetwork("")).rejects.toThrow("Invalid network")
    })()
  })
})

describe("prices.ts bounds and timer hygiene (#248)", () => {
  it("clears timeout on success or failure and does not leak timer", () => {
    return (async () => {
      const originalFetch = globalThis.fetch
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout")

      try {
        globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network failure"))
        const res = await fetchPrices([SOL_MINT])
        expect(res).toEqual({})
        expect(clearTimeoutSpy).toHaveBeenCalled()
      } finally {
        globalThis.fetch = originalFetch
        clearTimeoutSpy.mockRestore()
      }
    })()
  })

  it("filters invalid base58 mints, maps SOL to SOL_MINT, and ignores negative/NaN prices", () => {
    return (async () => {
      const originalFetch = globalThis.fetch
      try {
        const mockFetch = vi.fn().mockImplementation((url: string) => {
          expect(url).toContain(encodeURIComponent(SOL_MINT))
          expect(url).not.toContain("invalid-mint")
          return Promise.resolve({
            ok: true,
            json: async () => ({
              [SOL_MINT]: { usdPrice: 150.25, priceChange24h: 2.5 },
              "invalid-price": { usdPrice: -10, priceChange24h: 0 },
              "nan-price": { usdPrice: NaN, priceChange24h: 0 }
            })
          })
        })
        globalThis.fetch = mockFetch

        const prices = await fetchPrices(["SOL", "invalid-mint!@#$"])
        expect(prices[SOL_MINT]).toEqual({ usdPrice: 150.25, priceChange24h: 2.5 })
        expect(prices["SOL"]).toEqual({ usdPrice: 150.25, priceChange24h: 2.5 })
        expect(prices["invalid-price"]).toBeUndefined()
        expect(prices["nan-price"]).toBeUndefined()
      } finally {
        globalThis.fetch = originalFetch
      }
    })()
  })
})
