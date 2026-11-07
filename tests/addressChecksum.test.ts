import { describe, expect, it } from "vitest"

import {
  isValidShieldedAddress,
  parseShieldedAddress,
  shieldedChecksum,
  withChecksum
} from "../lib/crypto/addressChecksum"

// A representative 128-hex body: box pubkey (64) + spend pubkey (64).
const BODY128 = "0123456789abcdef".repeat(8)
const ADDR = `paraloom1${withChecksum(BODY128)}`

describe("shielded address checksum (#781)", () => {
  it("accepts a correctly checksummed address and returns its body", () => {
    expect(isValidShieldedAddress(ADDR)).toBe(true)
    expect(parseShieldedAddress(ADDR)).toBe(BODY128)
  })

  it("rejects a one-character substitution in the body (the core #781 case)", () => {
    // Flip the first body hex digit; length is unchanged.
    const flipped = (BODY128[0] === "1" ? "2" : "1") + BODY128.slice(1)
    const bad = `paraloom1${flipped}${shieldedChecksum(BODY128)}`
    expect(bad.length).toBe(ADDR.length) // same length, only a typo
    expect(isValidShieldedAddress(bad)).toBe(false)
  })

  it("rejects two transposed characters in the body", () => {
    const arr = BODY128.split("")
    ;[arr[10], arr[11]] = [arr[11], arr[10]]
    const swapped = arr.join("")
    // Only swap if it actually changed something.
    if (swapped !== BODY128) {
      const bad = `paraloom1${swapped}${shieldedChecksum(BODY128)}`
      expect(isValidShieldedAddress(bad)).toBe(false)
    }
  })

  it("rejects a legacy checksum-less address (128-hex body, no checksum)", () => {
    expect(isValidShieldedAddress(`paraloom1${BODY128}`)).toBe(false)
  })

  it("rejects a wrong prefix and non-hex", () => {
    expect(isValidShieldedAddress(`solana1${withChecksum(BODY128)}`)).toBe(false)
    expect(isValidShieldedAddress(`paraloom1${"z".repeat(136)}`)).toBe(false)
  })

  it("round-trips: withChecksum then parse returns the same body", () => {
    expect(parseShieldedAddress(`paraloom1${withChecksum(BODY128)}`)).toBe(BODY128)
  })

  it("rejects all-zero box or spend public keys and normalizes uppercase body hex", () => {
    const zeroBox = "0".repeat(64) + "0123456789abcdef".repeat(4)
    const zeroSpend = "0123456789abcdef".repeat(4) + "0".repeat(64)
    expect(() => shieldedChecksum(zeroBox)).toThrow(/invalid shielded address body/)
    expect(() => shieldedChecksum(zeroSpend)).toThrow(/invalid shielded address body/)
    expect(parseShieldedAddress(`paraloom1${BODY128.toUpperCase()}${shieldedChecksum(BODY128)}`)).toBe(
      BODY128
    )
  })
})
