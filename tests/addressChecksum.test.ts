import { describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  v3NotePubkey: vi.fn()
}))

import {
  isValidShieldedAddress,
  parseShieldedAddress,
  shieldedChecksum,
  withChecksum
} from "../lib/crypto/addressChecksum"
import { addressBoxPubHex, addressSpendPubHex } from "../lib/crypto/keyManagement"

// A representative 128-hex body: box pubkey (64) + spend pubkey (64).
const BODY128 = "0123456789abcdef".repeat(8)
const ADDR = `paraloom1${withChecksum(BODY128)}`

describe("shielded address checksum (#781)", () => {
  it("accepts a correctly checksummed address and returns its body", () => {
    expect(isValidShieldedAddress(ADDR)).toBe(true)
    expect(parseShieldedAddress(ADDR)).toBe(BODY128)
  })

  it("normalizes uppercase hex in body and checksum to lowercase", () => {
    const upperBody = BODY128.toUpperCase()
    const upperCsum = shieldedChecksum(upperBody).toUpperCase()
    const upperAddr = `paraloom1${upperBody}${upperCsum}`
    expect(isValidShieldedAddress(upperAddr)).toBe(true)
    expect(parseShieldedAddress(upperAddr)).toBe(BODY128) // normalized to lowercase
    expect(addressBoxPubHex(upperAddr)).toBe(BODY128.slice(0, 64))
    expect(addressSpendPubHex(upperAddr)).toBe(BODY128.slice(64, 128))
  })

  it("ensures case variants of same shielded address evaluate equal after parsing", () => {
    const upperAddr = `paraloom1${withChecksum(BODY128).toUpperCase()}`
    expect(parseShieldedAddress(upperAddr)).toBe(parseShieldedAddress(ADDR))
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
