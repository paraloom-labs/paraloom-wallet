import { describe, expect, it } from "vitest"

import {
  isValidShieldedAddress,
  parseShieldedAddress,
  shieldedChecksum,
  withChecksum
} from "../lib/crypto/addressChecksum"

// A representative 128-hex body: box pubkey (64) + spend pubkey (64).
const BODY128 = "0123456789abcdef".repeat(4) + "fedcba9876543210".repeat(4)
const ADDR = `paraloom1${withChecksum(BODY128)}`

describe("shielded address checksum (#781)", () => {
  it("accepts a correctly checksummed address and returns its body", () => {
    expect(isValidShieldedAddress(ADDR)).toBe(true)
    expect(parseShieldedAddress(ADDR)).toBe(BODY128)
  })

  it("normalizes uppercase hex to lowercase (#256)", () => {
    const upper = `paraloom1${withChecksum(BODY128).toUpperCase()}`
    expect(isValidShieldedAddress(upper)).toBe(true)
    expect(parseShieldedAddress(upper)).toBe(BODY128.toLowerCase())
  })

  it("rejects all-zero box pubkey, all-zero spend pubkey, and identical halves (#256)", () => {
    const zero64 = "0".repeat(64)
    const valid64 = "1".repeat(64)

    // All-zero box pubkey
    expect(isValidShieldedAddress(`paraloom1${zero64}${valid64}00000000`)).toBe(false)

    // All-zero spend pubkey
    expect(isValidShieldedAddress(`paraloom1${valid64}${zero64}00000000`)).toBe(false)

    // Identical halves (cross-primitive key reuse)
    const identical128 = "0123456789abcdef".repeat(8)
    expect(parseShieldedAddress(`paraloom1${identical128}00000000`)).toBeNull()
    expect(() => withChecksum(identical128)).toThrow("must be distinct")
    expect(() => shieldedChecksum(identical128)).toThrow("must be distinct")
  })

  it("rejects invalid bodyHex in shieldedChecksum and withChecksum (#256)", () => {
    expect(() => shieldedChecksum("tooshort")).toThrow("must be a 128-character hex string")
    expect(() => shieldedChecksum("z".repeat(128))).toThrow("must be a 128-character hex string")
    expect(() => withChecksum("tooshort")).toThrow("must be a 128-character hex string")
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
})
