import { describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({ NATIVE_ASSET_HEX: "00".repeat(32) }))

import { withChecksum } from "../lib/crypto/addressChecksum"
import {
  addressBoxPubHex,
  addressSpendPubHex
} from "../lib/crypto/keyManagement"
import { shieldedAddressToBytes } from "../lib/paraloom/bridge"

const BOX_64 = "0123456789abcdef".repeat(4)
const SPEND_64 = "fedcba9876543210".repeat(4)
const BODY_128 = `${BOX_64}${SPEND_64}`
const VALID_V2_ADDR = `paraloom1${withChecksum(BODY_128)}`

describe("addressBoxPubHex and addressSpendPubHex (#256)", () => {
  it("extracts 64-hex box and spend pubkeys from valid checksummed address", () => {
    expect(addressBoxPubHex(VALID_V2_ADDR)).toBe(BOX_64)
    expect(addressSpendPubHex(VALID_V2_ADDR)).toBe(SPEND_64)
  })

  it("normalizes uppercase hex addresses to lowercase", () => {
    const upperAddr = `paraloom1${withChecksum(BODY_128).toUpperCase()}`
    expect(addressBoxPubHex(upperAddr)).toBe(BOX_64.toLowerCase())
    expect(addressSpendPubHex(upperAddr)).toBe(SPEND_64.toLowerCase())
  })

  it("throws on truncated or corrupted addresses", () => {
    expect(() => addressBoxPubHex("paraloom1tooshort")).toThrow("Invalid shielded address")
    expect(() => addressSpendPubHex("paraloom1tooshort")).toThrow("Invalid shielded address")

    // Checksum corrupted
    const corrupted = VALID_V2_ADDR.slice(0, -1) + (VALID_V2_ADDR.endsWith("0") ? "1" : "0")
    expect(() => addressBoxPubHex(corrupted)).toThrow("Invalid shielded address")
    expect(() => addressSpendPubHex(corrupted)).toThrow("Invalid shielded address")
  })

  it("throws on degenerate addresses (all-zero or identical halves)", () => {
    const zero64 = "0".repeat(64)
    const allZeroAddr = `paraloom1${zero64}${zero64}00000000`
    expect(() => addressBoxPubHex(allZeroAddr)).toThrow("Invalid shielded address")
    expect(() => addressSpendPubHex(allZeroAddr)).toThrow("Invalid shielded address")
  })
})

describe("shieldedAddressToBytes (#256)", () => {
  it("rejects addresses without paraloom1 prefix", () => {
    expect(() => shieldedAddressToBytes(SPEND_64)).toThrow("missing paraloom1 prefix")
    expect(() => shieldedAddressToBytes(`solana1${SPEND_64}`)).toThrow("missing paraloom1 prefix")
  })

  it("rejects legacy address with non-hex characters", () => {
    const nonHex = "z".repeat(64)
    expect(() => shieldedAddressToBytes(`paraloom1${nonHex}`)).toThrow("non-hex characters")
  })

  it("rejects all-zero recipient bytes", () => {
    const allZeroLegacy = `paraloom1${"0".repeat(64)}`
    expect(() => shieldedAddressToBytes(allZeroLegacy)).toThrow("recipient cannot be all-zero")
  })

  it("extracts 32-byte recipient from valid legacy 64-hex address", () => {
    const legacy = `paraloom1${"ab".repeat(32)}`
    const bytes = shieldedAddressToBytes(legacy)
    expect(bytes).toHaveLength(32)
    expect(bytes).toEqual(Uint8Array.from(Buffer.from("ab".repeat(32), "hex")))
  })

  it("extracts 32-byte spend pubkey recipient from valid checksummed v2/v3 address", () => {
    const bytes = shieldedAddressToBytes(VALID_V2_ADDR)
    expect(bytes).toHaveLength(32)
    expect(bytes).toEqual(Uint8Array.from(Buffer.from(SPEND_64, "hex")))
  })

  it("rejects corrupted checksummed v2/v3 address", () => {
    const corrupted = VALID_V2_ADDR.slice(0, -2) + "ff"
    expect(() => shieldedAddressToBytes(corrupted)).toThrow("invalid shielded address")
  })
})
