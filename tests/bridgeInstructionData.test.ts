import { describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({ NATIVE_ASSET_HEX: "00".repeat(32) }))

import {
  depositInstructionData,
  depositSplInstructionData
} from "../lib/paraloom/bridge"
import { depositNoteInstructionData } from "../lib/paraloom/transact"

const VALID_KEY_32 = new Uint8Array(32).fill(1)
const VALID_BLINDING_32 = new Uint8Array(32).fill(2)

describe("depositInstructionData validation (#263)", () => {
  it("rejects amount <= 0n", () => {
    expect(() =>
      depositInstructionData(0n, VALID_KEY_32, VALID_BLINDING_32)
    ).toThrow("Invalid amount")

    expect(() =>
      depositInstructionData(-1n, VALID_KEY_32, VALID_BLINDING_32)
    ).toThrow("Invalid amount")
  })

  it("rejects amount > 2^64 - 1 (no silent ToBigUint64 wrapping)", () => {
    expect(() =>
      depositInstructionData(1n << 64n, VALID_KEY_32, VALID_BLINDING_32)
    ).toThrow("Invalid amount")

    expect(() =>
      depositInstructionData(
        0xffffffffffffffffn + 1n,
        VALID_KEY_32,
        VALID_BLINDING_32
      )
    ).toThrow("Invalid amount")
  })

  it("rejects non-32-byte recipient buffer (no zero-padding)", () => {
    expect(() =>
      depositInstructionData(1_000_000n, new Uint8Array(16), VALID_BLINDING_32)
    ).toThrow("Invalid recipient: must be exactly 32 bytes")

    expect(() =>
      depositInstructionData(1_000_000n, new Uint8Array(33), VALID_BLINDING_32)
    ).toThrow("Invalid recipient: must be exactly 32 bytes")
  })

  it("rejects non-32-byte randomness buffer (no zero-padding)", () => {
    expect(() =>
      depositInstructionData(1_000_000n, VALID_KEY_32, new Uint8Array(31))
    ).toThrow("Invalid randomness: must be exactly 32 bytes")
  })

  it("packs correctly for valid 64-bit bounds", () => {
    const dataMin = depositInstructionData(1n, VALID_KEY_32, VALID_BLINDING_32)
    expect(dataMin.byteLength).toBe(80)
    const viewMin = new DataView(dataMin.buffer, dataMin.byteOffset, dataMin.byteLength)
    expect(viewMin.getBigUint64(8, true)).toBe(1n)

    const maxU64 = 0xffffffffffffffffn
    const dataMax = depositInstructionData(maxU64, VALID_KEY_32, VALID_BLINDING_32)
    const viewMax = new DataView(dataMax.buffer, dataMax.byteOffset, dataMax.byteLength)
    expect(viewMax.getBigUint64(8, true)).toBe(maxU64)
  })
})

describe("depositSplInstructionData validation (#263)", () => {
  it("rejects amount <= 0n or > 2^64 - 1", () => {
    expect(() =>
      depositSplInstructionData(0n, VALID_KEY_32, VALID_BLINDING_32)
    ).toThrow("Invalid amount")

    expect(() =>
      depositSplInstructionData(1n << 64n, VALID_KEY_32, VALID_BLINDING_32)
    ).toThrow("Invalid amount")
  })

  it("rejects short or oversized pubkey and blinding", () => {
    expect(() =>
      depositSplInstructionData(500n, new Uint8Array(0), VALID_BLINDING_32)
    ).toThrow("Invalid pubkey: must be exactly 32 bytes")

    expect(() =>
      depositSplInstructionData(500n, VALID_KEY_32, new Uint8Array(30))
    ).toThrow("Invalid blinding: must be exactly 32 bytes")
  })

  it("packs valid SPL deposit payload", () => {
    const data = depositSplInstructionData(500_000n, VALID_KEY_32, VALID_BLINDING_32)
    expect(data.byteLength).toBe(80)
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    expect(view.getBigUint64(8, true)).toBe(500_000n)
  })
})

describe("depositNoteInstructionData validation (#263)", () => {
  it("rejects invalid amounts and non-32-byte buffers", () => {
    expect(() =>
      depositNoteInstructionData(-5n, VALID_KEY_32, VALID_BLINDING_32)
    ).toThrow("Invalid amount")

    expect(() =>
      depositNoteInstructionData(100n, new Uint8Array(10), VALID_BLINDING_32)
    ).toThrow("Invalid pubkey: must be exactly 32 bytes")

    expect(() =>
      depositNoteInstructionData(100n, VALID_KEY_32, new Uint8Array(35))
    ).toThrow("Invalid blinding: must be exactly 32 bytes")
  })

  it("packs valid deposit_note payload", () => {
    const data = depositNoteInstructionData(1234567n, VALID_KEY_32, VALID_BLINDING_32)
    expect(data.byteLength).toBe(80)
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    expect(view.getBigUint64(8, true)).toBe(1234567n)
  })
})
