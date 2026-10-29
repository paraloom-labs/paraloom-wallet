import { describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({
  v3NotePubkey: vi.fn(),
  NATIVE_ASSET_HEX: "00".repeat(32)
}))

import {
  isValidShieldedAddress,
  parseShieldedAddress,
  withChecksum
} from "../lib/crypto/addressChecksum"
import {
  addressBoxPubHex,
  addressSpendPubHex
} from "../lib/crypto/keyManagement"
import { fetchPrices } from "../lib/paraloom/prices"

const BODY128_LOWER = "0123456789abcdef".repeat(8)
const BODY128_UPPER = "0123456789ABCDEF".repeat(8)
const ADDR_LOWER = `paraloom1${withChecksum(BODY128_LOWER)}`
const ADDR_UPPER = `paraloom1${withChecksum(BODY128_LOWER).toUpperCase()}`

describe("Issue #140: Case-insensitive shielded address & self-transfer", () => {
  it("parseShieldedAddress returns normalized lowercase hex body", () => {
    const parsed = parseShieldedAddress(ADDR_UPPER)
    expect(parsed).not.toBeNull()
    // Prior behavior returned uppercase string BODY128_UPPER, breaking strict comparison with lowercase address
    expect(parsed).toBe(BODY128_LOWER)
  })

  it("addressBoxPubHex and addressSpendPubHex return lowercase hex for uppercase input", () => {
    const boxPub = addressBoxPubHex(ADDR_UPPER)
    const spendPub = addressSpendPubHex(ADDR_UPPER)
    expect(boxPub).toBe(boxPub.toLowerCase())
    expect(spendPub).toBe(spendPub.toLowerCase())
    expect(boxPub).toBe(BODY128_LOWER.slice(0, 64))
    expect(spendPub).toBe(BODY128_LOWER.slice(64, 128))
  })

  it("detects self-transfer case-insensitively when comparing normalized addresses", () => {
    const isSelfDirect = ADDR_UPPER === ADDR_LOWER
    // Direct === fails because of casing:
    expect(isSelfDirect).toBe(false)

    // With normalization, self-transfer is reliably detected:
    const normUpper = parseShieldedAddress(ADDR_UPPER)
    const normLower = parseShieldedAddress(ADDR_LOWER)
    expect(normUpper).toBe(normLower)
  })
})

describe("Issue #140: Token decimals preservation in prices", () => {
  it("TokenPrice captures decimals from price response when available", async () => {
    // Mock global fetch to return Jupiter v3 price payload with decimals
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": {
          usdPrice: 1.0002,
          priceChange24h: 0.01,
          decimals: 6
        }
      })
    })) as unknown as typeof fetch

    try {
      const prices = await fetchPrices(["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"])
      const usdtPrice = prices["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]
      expect(usdtPrice).toBeDefined()
      expect(usdtPrice.usdPrice).toBe(1.0002)
      // Must preserve decimals: 6
      expect(usdtPrice.decimals).toBe(6)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
