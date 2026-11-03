// Regression tests for the two issues in paraloom-wallet#113:
//  - depositV3 parsed the unbounded on-chain leaf index with Number(), silently
//    rounding indices above 2^53-1 and making the note unspendable;
//  - spendV3 padded a single-note spend with the real input's Merkle path,
//    leaking the leaf position and contradicting the dummy's leafIndex 0.
//
// Both helpers are pure, so these tests do not need the prover wasm or chrome.

import { describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  proveTransact: vi.fn(),
  v3MerklePath: vi.fn(),
  v3NoteCommitment: vi.fn(),
  v3NoteCommitmentAsset: vi.fn(),
  v3NotePubkey: vi.fn()
}))

import { dummyMerklePath, parseDepositLeafIndex } from "~lib/paraloom/transactFlow"

const LEAF_LINE = (n: string | number) => `Program log: Deposit note appended at leaf ${n}`

describe("parseDepositLeafIndex (#113)", () => {
  it("returns -1 when the transaction has no deposit event", () => {
    expect(parseDepositLeafIndex([])).toBe(-1)
    expect(parseDepositLeafIndex(["Program log: something else"])).toBe(-1)
  })

  it("parses the reported leaf index", () => {
    expect(parseDepositLeafIndex(["Program log: init", LEAF_LINE(42)])).toBe(42)
  })

  it("keeps the last event when more than one is present", () => {
    expect(parseDepositLeafIndex([LEAF_LINE(1), LEAF_LINE(2)])).toBe(2)
  })

  it("accepts Number.MAX_SAFE_INTEGER without losing precision", () => {
    expect(parseDepositLeafIndex([LEAF_LINE("9007199254740991")])).toBe(Number.MAX_SAFE_INTEGER)
  })

  it("rejects an index above Number.MAX_SAFE_INTEGER instead of rounding it", () => {
    // Number("9007199254740992") === 9007199254740992 but the next integer
    // (9007199254740993) also rounds to it, so accepting this value would
    // persist an index that may point at a different leaf.
    expect(() => parseDepositLeafIndex([LEAF_LINE("9007199254740992")])).toThrow(
      /exceeds safe integer precision/
    )
    expect(() => parseDepositLeafIndex([LEAF_LINE("9007199254740993")])).toThrow(
      /exceeds safe integer precision/
    )
  })
})

describe("dummyMerklePath (#113)", () => {
  it("returns a 32-level path of zeroed siblings", () => {
    const path = dummyMerklePath()
    expect(path).toHaveLength(32)
    expect(path.every((node) => node === "00".repeat(32))).toBe(true)
  })

  it("returns a fresh array on each call", () => {
    expect(dummyMerklePath()).not.toBe(dummyMerklePath())
  })
})
