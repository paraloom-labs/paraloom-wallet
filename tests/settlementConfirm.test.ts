import { describe, expect, it } from "vitest"

import {
  confirmCommitmentInTree,
  expectedWithdrawNetAmount,
  hasExpectedBalanceRise,
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
})

describe("hasExpectedBalanceRise (#1632)", () => {
  it("computes the exact net payout after the 25 bps protocol withdrawal fee", () => {
    // 1 SOL = 1_000_000_000 lamports -> fee = 2_500_000 -> net = 997_500_000
    expect(expectedWithdrawNetAmount(1_000_000_000n)).toBe(997_500_000n)
    // 500 lamports -> fee = floor(500 * 25 / 10_000) = 1 -> net = 499
    expect(expectedWithdrawNetAmount(500n)).toBe(499n)
    expect(expectedWithdrawNetAmount(0n)).toBe(0n)
  })

  it("rejects 1-lamport dust and partial balance rises below the net payout", () => {
    const before = 100_000_000n
    const grossWithdraw = 1_000_000_000n // net expected = 997_500_000n
    // 1-lamport dust transfer during the poll window must NOT trigger settlement
    expect(hasExpectedBalanceRise(before, before + 1n, grossWithdraw)).toBe(false)
    // 1 lamport short of net payout is still rejected
    expect(hasExpectedBalanceRise(before, before + 997_499_999n, grossWithdraw)).toBe(false)
    // Unchanged or lower balance is rejected
    expect(hasExpectedBalanceRise(before, before, grossWithdraw)).toBe(false)
  })

  it("accepts a balance rise equal to or greater than the net withdrawal payout", () => {
    const before = 100_000_000n
    const grossWithdraw = 1_000_000_000n
    expect(hasExpectedBalanceRise(before, before + 997_500_000n, grossWithdraw)).toBe(true)
    expect(hasExpectedBalanceRise(before, before + 1_000_000_000n, grossWithdraw)).toBe(true)
  })
})
