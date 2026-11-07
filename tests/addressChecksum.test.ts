import { describe, expect, it, vi } from "vitest"
import {
  isValidShieldedAddress,
  parseShieldedAddress,
  shieldedChecksum,
  withChecksum
} from "../lib/crypto/addressChecksum"
import { addressBoxPubHex, addressSpendPubHex } from "../lib/crypto/keyManagement"
import { shieldedAddressToBytes } from "../lib/paraloom/bridge"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  v3NotePubkey: vi.fn()
}))

// A representative 128-hex body: box pubkey (64) + spend pubkey (64).
const BOX64 = "0123456789abcdef".repeat(4)
const SPEND64 = "fedcba9876543210".repeat(4)
const BODY128 = `${BOX64}${SPEND64}`
const ADDR = `paraloom1${withChecksum(BODY128)}`

describe("shielded address checksum (#781, #256)", () => {
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

  it("rejects all-zero box pubkey", () => {
    const zeroBoxBody = `${"0".repeat(64)}${SPEND64}`
    const zeroBoxAddr = `paraloom1${withChecksum(zeroBoxBody)}`
    expect(isValidShieldedAddress(zeroBoxAddr)).toBe(false)
    expect(parseShieldedAddress(zeroBoxAddr)).toBe(null)
  })

  it("rejects all-zero spend pubkey", () => {
    const zeroSpendBody = `${BOX64}${"0".repeat(64)}`
    const zeroSpendAddr = `paraloom1${withChecksum(zeroSpendBody)}`
    expect(isValidShieldedAddress(zeroSpendAddr)).toBe(false)
    expect(parseShieldedAddress(zeroSpendAddr)).toBe(null)
  })

  it("rejects identical box and spend pubkeys", () => {
    const identicalBody = `${BOX64}${BOX64}`
    const identicalAddr = `paraloom1${withChecksum(identicalBody)}`
    expect(isValidShieldedAddress(identicalAddr)).toBe(false)
    expect(parseShieldedAddress(identicalAddr)).toBe(null)
  })

  it("addressBoxPubHex and addressSpendPubHex validate checksum and return respective halves", () => {
    expect(addressBoxPubHex(ADDR)).toBe(BOX64)
    expect(addressSpendPubHex(ADDR)).toBe(SPEND64)

    // Tampered checksum throws
    const badCsum = ADDR.slice(0, -2) + "00"
    expect(() => addressBoxPubHex(badCsum)).toThrow("Invalid shielded address")
    expect(() => addressSpendPubHex(badCsum)).toThrow("Invalid shielded address")

    // All-zero box/spend or identical box/spend throws
    const identicalAddr = `paraloom1${withChecksum(`${BOX64}${BOX64}`)}`
    expect(() => addressBoxPubHex(identicalAddr)).toThrow("Invalid shielded address")
    expect(() => addressSpendPubHex(identicalAddr)).toThrow("Invalid shielded address")

    // Legacy unchecksummed throws
    expect(() => addressBoxPubHex(`paraloom1${BODY128}`)).toThrow("Invalid shielded address")
    expect(() => addressSpendPubHex(`paraloom1${BODY128}`)).toThrow("Invalid shielded address")
  })

  it("shieldedAddressToBytes converts valid paraloom1<64-hex> and rejects non-prefixed or non-hex strings", () => {
    const raw64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    const validAddr = `paraloom1${raw64}`

    const bytes = shieldedAddressToBytes(validAddr)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBe(32)
    expect(Buffer.from(bytes).toString("hex")).toBe(raw64)

    // Non-prefixed string is rejected
    expect(() => shieldedAddressToBytes(raw64)).toThrow("invalid shielded address")

    // Non-hex string is rejected
    const nonHex = `paraloom1${"g".repeat(64)}`
    expect(() => shieldedAddressToBytes(nonHex)).toThrow("invalid shielded address")

    // Wrong length is rejected
    expect(() => shieldedAddressToBytes(`paraloom1${raw64.slice(0, 62)}`)).toThrow(
      "invalid shielded address"
    )
    expect(() => shieldedAddressToBytes(`paraloom1${raw64}00`)).toThrow("invalid shielded address")

    // Non-string is rejected
    expect(() => shieldedAddressToBytes(null as unknown as string)).toThrow(
      "invalid shielded address"
    )
  })
})
