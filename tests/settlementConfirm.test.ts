import { describe, expect, it } from "vitest"

import {
  confirmCommitmentInTree,
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

  it("matches commitment with uppercase hex or 0x prefix", async () => {
    const clock = fakeClock(1000)
    const uppercaseTarget = TARGET.toUpperCase()
    const settledUpper = await confirmCommitmentInTree(
      async () => [{ commitmentHex: TARGET }],
      uppercaseTarget,
      5000,
      1000,
      clock
    )
    expect(settledUpper).toBe(true)

    const settledWithPrefix = await confirmCommitmentInTree(
      async () => [{ commitmentHex: "0x" + TARGET.toUpperCase() }],
      TARGET,
      5000,
      1000,
      clock
    )
    expect(settledWithPrefix).toBe(true)
  })

  it("does not busy-spin on pollMs <= 0 and uses default poll interval", async () => {
    let calls = 0
    const sleepCalls: number[] = []
    let t = 0
    const clock = {
      now: () => t,
      sleep: async (ms: number) => {
        sleepCalls.push(ms)
        t += ms
      }
    }
    const settled = await confirmCommitmentInTree(
      async () => {
        calls += 1
        return [{ commitmentHex: OTHER }]
      },
      TARGET,
      3000,
      0,
      clock
    )
    expect(settled).toBe(false)
    expect(calls).toBe(4)
    expect(sleepCalls.every((ms) => ms > 0)).toBe(true)
  })

  it("does not overshoot timeoutMs when remaining time is less than pollMs", async () => {
    let t = 0
    const sleepCalls: number[] = []
    const clock = {
      now: () => t,
      sleep: async (ms: number) => {
        sleepCalls.push(ms)
        t += ms
      }
    }
    // timeout is 2500ms, poll interval is 1000ms.
    // Polls at t=0 (sleep 1000 -> t=1000), t=1000 (sleep 1000 -> t=2000),
    // t=2000 (sleep 500 -> t=2500), t=2500 (hits deadline, stops).
    const settled = await confirmCommitmentInTree(
      async () => [{ commitmentHex: OTHER }],
      TARGET,
      2500,
      1000,
      clock
    )
    expect(settled).toBe(false)
    expect(t).toBe(2500)
    expect(sleepCalls).toEqual([1000, 1000, 500])
  })
})
