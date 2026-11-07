import { describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  v3NotePubkey: vi.fn(),
  depositV3: vi.fn(),
  spendV3: vi.fn()
}))
vi.mock("data-base64:~/../assets/icon.png", () => ({ default: "mock-icon" }))

import { parseSolToLamports } from "../src/popup/Home"
import { pickDecoys } from "../src/popup/Onboarding"

describe("parseSolToLamports", () => {
  it("parses valid SOL amounts to lamports", () => {
    expect(parseSolToLamports("1")).toBe(1_000_000_000n)
    expect(parseSolToLamports("0.5")).toBe(500_000_000n)
    expect(parseSolToLamports("0.000000001")).toBe(1n)
    expect(parseSolToLamports("12.3456789")).toBe(12_345_678_900n)
  })

  it("handles whitespace in inputs", () => {
    expect(parseSolToLamports("  2.5  ")).toBe(2_500_000_000n)
  })

  it("rejects non-positive and zero amounts", () => {
    expect(parseSolToLamports("0")).toBeNull()
    expect(parseSolToLamports("-1")).toBeNull()
    expect(parseSolToLamports("-0.5")).toBeNull()
    expect(parseSolToLamports("")).toBeNull()
    expect(parseSolToLamports("   ")).toBeNull()
  })

  it("rejects Infinity and NaN without throwing RangeError", () => {
    expect(parseSolToLamports("Infinity")).toBeNull()
    expect(parseSolToLamports("+Infinity")).toBeNull()
    expect(parseSolToLamports("-Infinity")).toBeNull()
    expect(parseSolToLamports("NaN")).toBeNull()
    expect(parseSolToLamports("abc")).toBeNull()
  })

  it("rejects sub-lamport amounts (< 1 lamport) without truncating to 0n", () => {
    // 1 lamport = 1e-9 SOL = 0.000000001 SOL
    expect(parseSolToLamports("0.0000000001")).toBeNull()
    expect(parseSolToLamports("0.0000000004")).toBeNull()
    expect(parseSolToLamports("0.0000000009")).toBeNull()
    expect(parseSolToLamports("0.00000000001")).toBeNull()
  })
})

describe("pickDecoys", () => {
  const seedWords = [
    "abandon", "ability", "able", "about", "above", "absent",
    "absorb", "abstract", "absurd", "abuse", "access", "accident"
  ]

  it("picks requested count of decoy words that do not include correct word", () => {
    const decoys = pickDecoys("abandon", seedWords, 3)
    expect(decoys.length).toBe(3)
    expect(decoys).not.toContain("abandon")
    // Each decoy must be unique
    const unique = new Set(decoys)
    expect(unique.size).toBe(3)
  })

  it("does not emit duplicate decoy keys when seed phrase contains duplicate words", () => {
    const seedWithDuplicates = [
      "apple", "banana", "banana", "banana", "banana", "banana",
      "cherry", "date", "elderberry", "fig", "grape", "honeydew"
    ]
    // Repeat multiple times to test randomness
    for (let i = 0; i < 20; i++) {
      const decoys = pickDecoys("apple", seedWithDuplicates, 3)
      expect(decoys.length).toBe(3)
      expect(decoys).not.toContain("apple")
      const unique = new Set(decoys)
      expect(unique.size).toBe(3)
    }
  })

  it("falls back to unique words when allWords has fewer unique words than count", () => {
    const degenerateSeed = [
      "about", "about", "about", "about", "about", "about",
      "about", "about", "about", "about", "about", "about"
    ]
    const decoys = pickDecoys("about", degenerateSeed, 3)
    expect(decoys.length).toBe(3)
    expect(decoys).not.toContain("about")
    const unique = new Set(decoys)
    expect(unique.size).toBe(3)
  })
})
