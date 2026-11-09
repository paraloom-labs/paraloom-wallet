import { describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  v3NotePubkey: vi.fn(async () => "00".repeat(32))
}))
vi.mock("data-base64:~/../assets/icon.png", () => ({
  default: "data:image/png;base64,fake"
}))

import { confirmCommitmentInTree, type LeafRef } from "~lib/paraloom/settlementConfirm"
import { parseSolInputToLamports } from "~lib/paraloom/bridge"
import { pickDecoys } from "~src/popup/Onboarding"

const TARGET_HEX = "aa".repeat(32)
const OTHER_HEX = "bb".repeat(32)

function fakeClock() {
  let t = 0
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      t += ms
    },
    get sleeps() {
      return sleeps
    },
    get elapsed() {
      return t
    }
  }
}

describe("confirmCommitmentInTree (#238)", () => {
  it("matches uppercase and mixed-case commitmentHex against lowercase tree leaves", async () => {
    const clock = fakeClock()
    const settled = await confirmCommitmentInTree(
      async () => [{ commitmentHex: TARGET_HEX.toLowerCase() }],
      TARGET_HEX.toUpperCase(),
      5000,
      1000,
      clock
    )
    expect(settled).toBe(true)
  })

  it("matches lowercase commitmentHex against uppercase tree leaves", async () => {
    const clock = fakeClock()
    const settled = await confirmCommitmentInTree(
      async () => [{ commitmentHex: TARGET_HEX.toUpperCase() }],
      TARGET_HEX.toLowerCase(),
      5000,
      1000,
      clock
    )
    expect(settled).toBe(true)
  })

  it("rejects empty commitmentHex and non-64-character hex strings", async () => {
    const clock = fakeClock()
    await expect(confirmCommitmentInTree(async () => [], "", 5000, 1000, clock)).rejects.toThrow("invalid commitmentHex")
    await expect(confirmCommitmentInTree(async () => [], "not-a-hex", 5000, 1000, clock)).rejects.toThrow("invalid commitmentHex")
    await expect(confirmCommitmentInTree(async () => [], "aa".repeat(31), 5000, 1000, clock)).rejects.toThrow("invalid commitmentHex")
    await expect(confirmCommitmentInTree(async () => [], "aa".repeat(33), 5000, 1000, clock)).rejects.toThrow("invalid commitmentHex")
  })

  it("rejects non-positive and non-finite pollMs and timeoutMs", async () => {
    const clock = fakeClock()
    await expect(confirmCommitmentInTree(async () => [], TARGET_HEX, 5000, 0, clock)).rejects.toThrow("pollMs must be a positive finite number")
    await expect(confirmCommitmentInTree(async () => [], TARGET_HEX, 5000, -100, clock)).rejects.toThrow("pollMs must be a positive finite number")
    await expect(confirmCommitmentInTree(async () => [], TARGET_HEX, 5000, NaN, clock)).rejects.toThrow("pollMs must be a positive finite number")
    await expect(confirmCommitmentInTree(async () => [], TARGET_HEX, 0, 1000, clock)).rejects.toThrow("timeoutMs must be a positive finite number")
    await expect(confirmCommitmentInTree(async () => [], TARGET_HEX, -50, 1000, clock)).rejects.toThrow("timeoutMs must be a positive finite number")
  })

  it("clamps sleep to remaining deadline time so it never overshoots timeoutMs", async () => {
    const clock = fakeClock()
    let calls = 0
    // timeoutMs = 2500, pollMs = 1000
    // Expected poll schedule:
    // t=0: fetch #1, sleep(1000) -> t=1000
    // t=1000: fetch #2, sleep(1000) -> t=2000
    // t=2000: fetch #3, remaining deadline is 500ms, clamped sleep(500) -> t=2500
    // t=2500: fetch #4, hits deadline and stops
    const settled = await confirmCommitmentInTree(
      async (): Promise<LeafRef[]> => {
        calls += 1
        return [{ commitmentHex: OTHER_HEX }]
      },
      TARGET_HEX,
      2500,
      1000,
      clock
    )
    expect(settled).toBe(false)
    expect(calls).toBe(4)
    expect(clock.sleeps).toEqual([1000, 1000, 500])
    expect(clock.elapsed).toBe(2500)
  })
})

describe("parseSolInputToLamports (#238)", () => {
  it("parses whole and decimal SOL amounts to exact lamports", () => {
    expect(parseSolInputToLamports("1")).toBe(1_000_000_000n)
    expect(parseSolInputToLamports("2.5")).toBe(2_500_000_000n)
    expect(parseSolInputToLamports("0.123456789")).toBe(123_456_789n)
    expect(parseSolInputToLamports("0.000000001")).toBe(1n)
    expect(parseSolInputToLamports(".5")).toBe(500_000_000n)
    expect(parseSolInputToLamports("1.")).toBe(1_000_000_000n)
    expect(parseSolInputToLamports("  0.75  ")).toBe(750_000_000n)
    expect(parseSolInputToLamports("1.0000000000")).toBe(1_000_000_000n)
  })

  it("rejects sub-lamport amounts instead of truncating to 0n", () => {
    // 4e-10 SOL is less than 1 lamport
    expect(parseSolInputToLamports("0.0000000004")).toBeNull()
    // 10 decimal digits with non-zero 10th digit
    expect(parseSolInputToLamports("0.1234567891")).toBeNull()
  })

  it("rejects zero, negative, and invalid numerical formats", () => {
    expect(parseSolInputToLamports("0")).toBeNull()
    expect(parseSolInputToLamports("0.0")).toBeNull()
    expect(parseSolInputToLamports("0.000000000")).toBeNull()
    expect(parseSolInputToLamports("-1")).toBeNull()
    expect(parseSolInputToLamports("-0.5")).toBeNull()
    expect(parseSolInputToLamports("+1")).toBeNull()
    expect(parseSolInputToLamports("")).toBeNull()
    expect(parseSolInputToLamports("   ")).toBeNull()
    expect(parseSolInputToLamports("abc")).toBeNull()
  })

  it("rejects Infinity, NaN, scientific notation, and overflow inputs", () => {
    expect(parseSolInputToLamports("Infinity")).toBeNull()
    expect(parseSolInputToLamports("-Infinity")).toBeNull()
    expect(parseSolInputToLamports("NaN")).toBeNull()
    expect(parseSolInputToLamports("1e9")).toBeNull()
    expect(parseSolInputToLamports("1e-9")).toBeNull()
    expect(parseSolInputToLamports("99999999999999999999999999999")).toBeNull()
  })
})

describe("pickDecoys (#238)", () => {
  it("never includes the correct word in decoys", () => {
    const allWords = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]
    for (let i = 0; i < 20; i++) {
      const decoys = pickDecoys("alpha", allWords, 3)
      expect(decoys).not.toContain("alpha")
      expect(decoys.length).toBe(3)
    }
  })

  it("deduplicates repeated words in the input wordlist", () => {
    const wordsWithDuplicates = ["apple", "apple", "banana", "banana", "cherry"]
    const decoys = pickDecoys("apple", wordsWithDuplicates, 3)
    // There are only 2 distinct words in wordsWithDuplicates other than "apple" ("banana", "cherry")
    // pickDecoys must top up from BIP-39 wordlist and guarantee 3 distinct decoys!
    expect(decoys.length).toBe(3)
    const uniqueDecoys = new Set(decoys)
    expect(uniqueDecoys.size).toBe(3)
    expect(uniqueDecoys.has("apple")).toBe(false)
  })

  it("tops up from BIP-39 wordlist when input has fewer distinct words than requested count", () => {
    const minimalWords = ["correct"]
    const decoys = pickDecoys("correct", minimalWords, 3)
    expect(decoys.length).toBe(3)
    const uniqueDecoys = new Set(decoys)
    expect(uniqueDecoys.size).toBe(3)
    expect(uniqueDecoys.has("correct")).toBe(false)
  })
})
