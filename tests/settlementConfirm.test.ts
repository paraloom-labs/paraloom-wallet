import { describe, expect, it } from "vitest"
import {
  CONFIRM_POLL_MS,
  CONFIRM_TIMEOUT_MS,
  confirmCommitmentInTree,
  confirmSettledWith,
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

// A caller-supplied settlement predicate (the shape a withdraw caller can still
// pass) runs AFTER the spend was queued at the ingress, so the clock here is the
// caller's: the predicate owns its timeout and signals it by returning false.
// What this helper owns is that a THROW never escapes.
describe("confirmSettledWith", () => {
  it("returns the predicate's true immediately", async () => {
    let calls = 0
    const settled = await confirmSettledWith(async () => {
      calls += 1
      return true
    })
    expect(settled).toBe(true)
    expect(calls).toBe(1)
  })

  it("re-polls a throwing predicate instead of aborting", async () => {
    // The core guard: one RPC hiccup must not abort the bookkeeping that marks
    // the inputs spent and books the change (#196).
    let calls = 0
    const clock = fakeClock(1000)
    const settled = await confirmSettledWith(async () => {
      calls += 1
      if (calls <= 2) throw new Error("RPC 502")
      return true
    }, clock)
    expect(settled).toBe(true)
    expect(calls).toBe(3)
  })

  it("gives up once the ceiling passes while it keeps throwing", async () => {
    let calls = 0
    const clock = fakeClock(CONFIRM_POLL_MS)
    const settled = await confirmSettledWith(async () => {
      calls += 1
      throw new Error("RPC 502")
    }, clock)
    expect(settled).toBe(false)
    // One poll per interval until the deadline, then the timeout is a refusal —
    // never a false "settled".
    expect(calls).toBe(Math.ceil(CONFIRM_TIMEOUT_MS / CONFIRM_POLL_MS) + 1)
  })

  it("treats a false as final, not as a transient error", async () => {
    // A predicate that has already run out of its own patience must not be
    // re-polled — that would multiply the caller's timeout by ours.
    let calls = 0
    const settled = await confirmSettledWith(async () => {
      calls += 1
      return false
    })
    expect(settled).toBe(false)
    expect(calls).toBe(1)
  })
})
