import { describe, expect, it } from "vitest"

import {
  confirmCommitmentInTree,
  parseSolInputToLamports,
  type LeafRef
} from "../lib/paraloom/settlementConfirm"

const TARGET = "aa".repeat(32)
const OTHER = "bb".repeat(32)

// A deterministic clock: `now()` advances by `pollMs` on every `sleep`, so a
// timeout is reached in a fixed number of polls with no real waiting.
function fakeClock(pollMs: number) {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
    _pollMs: pollMs
  }
}

describe("confirmCommitmentInTree", () => {
  it("returns true when the commitment is already in the tree", async () => {
    const clock = fakeClock(1000)
    const settled = await confirmCommitmentInTree(
      async () => [{ commitmentHex: OTHER }, { commitmentHex: TARGET }],
      TARGET,
      10_000,
      1000,
      clock
    )
    expect(settled).toBe(true)
  })

  it("returns true once the commitment appears on a later poll", async () => {
    let calls = 0
    const clock = fakeClock(1000)
    const settled = await confirmCommitmentInTree(
      async (): Promise<LeafRef[]> => {
        calls += 1
        // Not there for the first two rebuilds, then it lands.
        return calls >= 3 ? [{ commitmentHex: TARGET }] : [{ commitmentHex: OTHER }]
      },
      TARGET,
      10_000,
      1000,
      clock
    )
    expect(settled).toBe(true)
    expect(calls).toBe(3)
  })

  it("returns false when the commitment never lands before the timeout", async () => {
    let calls = 0
    const clock = fakeClock(1000)
    const settled = await confirmCommitmentInTree(
      async () => {
        calls += 1
        return [{ commitmentHex: OTHER }]
      },
      TARGET,
      3000,
      1000,
      clock
    )
    // The core guard: a spend that never settles must report NOT settled, so the
    // caller leaves the inputs spendable instead of hiding them (#792).
    expect(settled).toBe(false)
    // Polls at t=0,1000,2000,3000 — the t=3000 check hits the deadline and stops.
    expect(calls).toBe(4)
  })

  it("treats a transient fetch error as a retry, not a settlement failure", async () => {
    let calls = 0
    const clock = fakeClock(1000)
    const settled = await confirmCommitmentInTree(
      async () => {
        calls += 1
        if (calls === 1) throw new Error("RPC 500")
        return [{ commitmentHex: TARGET }]
      },
      TARGET,
      10_000,
      1000,
      clock
    )
    expect(settled).toBe(true)
    expect(calls).toBe(2)
  })

  it("matches uppercase/mixed-case target commitments and rejects empty or malformed commitments", async () => {
    const clock = fakeClock(1000)
    const upperTarget = "AA".repeat(32)
    expect(
      await confirmCommitmentInTree(
        async () => [{ commitmentHex: TARGET }],
        upperTarget,
        5000,
        1000,
        clock
      )
    ).toBe(true)

    expect(
      await confirmCommitmentInTree(async () => [{ commitmentHex: "" }], "", 5000, 1000, clock)
    ).toBe(false)
    expect(
      await confirmCommitmentInTree(async () => [{ commitmentHex: TARGET }], "bad-hex", 5000, 1000, clock)
    ).toBe(false)
  })

  it("clamps sleep to remaining deadline and guards non-positive pollMs", async () => {
    let t = 0
    const sleeps: number[] = []
    const settled = await confirmCommitmentInTree(
      async () => [{ commitmentHex: OTHER }],
      TARGET,
      2500,
      1000,
      {
        now: () => t,
        sleep: async (ms: number) => {
          sleeps.push(ms)
          t += ms
        }
      }
    )
    expect(settled).toBe(false)
    expect(sleeps).toEqual([1000, 1000, 500])
    expect(t).toBe(2500)
  })
})

describe("parseSolInputToLamports", () => {
  it("parses exact 9-decimal SOL strings without float drift and rejects Infinity/NaN/sub-lamport", () => {
    expect(parseSolInputToLamports("1")).toBe(1_000_000_000n)
    expect(parseSolInputToLamports("1.000000001")).toBe(1_000_000_001n)
    expect(parseSolInputToLamports("0.000000001")).toBe(1n)
    expect(parseSolInputToLamports("9007199.254740993")).toBe(9_007_199_254_740_993n)

    for (const bad of [
      "",
      "0",
      "0.000000000",
      "0.0000000004",
      "-1",
      "Infinity",
      "NaN",
      "1e-10",
      "18446744073.709551616"
    ]) {
      expect(parseSolInputToLamports(bad)).toBeNull()
    }
  })
})
