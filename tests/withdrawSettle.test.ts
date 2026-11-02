// A withdraw used to confirm settlement with a raw recipient-balance delta in
// the popup (paraloom-wallet#196): `getSolBalance(...) > before`. That signal is
// neither sufficient nor necessary. ANY unrelated inflow during the window — an
// incoming transfer, a rent refund, 1 lamport of dust — reads as "settled" while
// the quorum may have dropped the request, so the inputs are marked spent and a
// change note is booked whose commitment never landed. A concurrent outflow
// reads as "not settled" long after it did, and one failed balance read throws
// out of spendV3 AFTER submission, skipping the same bookkeeping.
//
// The fix is to let spendV3's default decide: the first output commitment
// appearing in the on-chain tree. These tests pin that the tree decides on its
// own and that the bookkeeping runs exactly once it does — never on a balance
// movement, never after a transient poll error.

import type { ShieldedNote } from "~lib/paraloom/notes"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { installFakeChrome } from "./support/chromeStorage"

const OWN_PUB = "11".repeat(32)
const OWN_BOX_PUB = "22".repeat(32)
const RECIPIENT = "33".repeat(32)

// Every commitment the mocked prover computes, so a test can publish the exact
// change-output commitment as an on-chain leaf without re-deriving the blinding.
const commitments: { amount: bigint; hex: string }[] = []

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  // Deterministic stand-in for Poseidon: the tests only need stable identity,
  // not the real curve. The random blinding still flows through, so the change
  // and filler outputs get distinct commitments as they do for real.
  v3NotePubkey: async () => OWN_PUB,
  v3NoteCommitment: async (amount: bigint, pubkeyHex: string, blindingHex: string) => {
    const hex = `${amount.toString(16).padStart(16, "0")}${pubkeyHex.slice(0, 16)}${blindingHex.slice(0, 32)}`
    commitments.push({ amount, hex })
    return hex
  },
  v3NoteCommitmentAsset: async (amount: bigint, pubkeyHex: string, blindingHex: string) =>
    `${amount.toString(16).padStart(16, "0")}${pubkeyHex.slice(0, 16)}${blindingHex.slice(0, 32)}`,
  v3MerklePath: async () => ({ path: ["00".repeat(32)], root: "44".repeat(32) }),
  proveTransact: async () => JSON.stringify({ nullifiers: [], output_commitments: [], proof: "" })
}))

// The on-chain tree as the tests drive it: `leaves` is what each poll sees, and
// `fetchThrows` makes the next N polls fail like a flaky RPC. Throws are armed
// only AFTER submission — a failing rebuild before it is a different case
// (nothing is queued yet, so throwing there is correct).
const tree: { leaves: { commitmentHex: string }[]; fetchThrows: number; submitted: boolean } = {
  leaves: [],
  fetchThrows: 0,
  submitted: false
}

// The recipient's PUBLIC wallet on the mock connection. It is deliberately made
// to grow while the (mocked) tree stays unchanged, which is exactly the false
// positive the balance poll had: an unrelated inflow reads as "settled".
const connection = {
  balance: 0n,
  balanceReads: 0,
  async getBalance() {
    connection.balanceReads += 1
    return connection.balance
  }
}

vi.mock("~lib/paraloom/transact", () => ({
  fetchV3Leaves: async () => {
    if (tree.submitted && tree.fetchThrows > 0) {
      tree.fetchThrows -= 1
      throw new Error("RPC 500")
    }
    return tree.leaves.map((l) => l)
  },
  submitTransact: async () => {
    tree.submitted = true
    return { requestId: "req-196" }
  }
}))

const { spendV3 } = await import("~lib/paraloom/transactFlow")
const { getNotes, addNote, shieldedBalance } = await import("~lib/paraloom/notes")

const ACCOUNT = "paraloom1" + "ab".repeat(64)
const INPUT = "c0".repeat(32)
const INPUT_AMOUNT = 10_000n
const PAY = 4_000n
const CHANGE = INPUT_AMOUNT - PAY
const POLL_MS = 6_000

function inputNote(): ShieldedNote {
  return {
    amount: INPUT_AMOUNT.toString(),
    blinding: "bb".repeat(32),
    assetId: "00".repeat(32),
    signature: "",
    createdAt: 1,
    spent: false,
    commitment: INPUT,
    source: "transfer",
    leafIndex: 0
  }
}

function spend(confirmSettled?: () => Promise<boolean>) {
  return spendV3(
    connection as never,
    ACCOUNT,
    "dd".repeat(32),
    OWN_BOX_PUB,
    [inputNote()],
    PAY,
    { kind: "withdraw", recipientSolanaHex: RECIPIENT },
    confirmSettled ? { confirmSettled } : {}
  )
}

// Advance the fake clock one poll at a time until `done()` holds. The confirm
// loop only ever waits on setTimeout, so this is what its polling looks like.
async function until(done: () => boolean, steps = 40): Promise<void> {
  for (let i = 0; i < steps && !done(); i++) {
    await vi.advanceTimersByTimeAsync(POLL_MS)
  }
}

// Run a spend to completion: advance until it settles. The default 150s/6s
// budget needs 25 polls, well inside `steps`.
async function drain<T>(p: Promise<T>): Promise<T> {
  let settled = false
  const tracked = p.finally(() => {
    settled = true
  })
  await until(() => settled)
  return tracked
}

// Wait until spendV3 has computed the change-output commitment (it does so
// before the first poll), so a test can publish exactly that leaf.
async function changeCommitment(pending: Promise<unknown>): Promise<string> {
  await until(() => commitments.some((c) => c.amount === CHANGE) || !pending)
  return commitments.find((c) => c.amount === CHANGE)!.hex
}

// `connection.getBalance` is only read by a confirmSettled override; spendV3's
// default polls the tree instead, so a frozen `balanceReads` at 0 pins that the
// outcome came from the tree and not from a balance delta.

beforeEach(async () => {
  installFakeChrome()
  commitments.length = 0
  tree.leaves = [{ commitmentHex: INPUT }]
  tree.fetchThrows = 0
  tree.submitted = false
  connection.balance = 0n
  connection.balanceReads = 0
  vi.useFakeTimers()
  await addNote(ACCOUNT, inputNote())
})

describe("withdraw settlement is decided by the tree, not by a balance delta", () => {
  it("does not confirm on a balance movement the tree knows nothing about", async () => {
    // The false positive: the recipient is funded (an unrelated transfer, a rent
    // refund, 1 lamport of dust — anything) yet nothing lands in the tree, so
    // the quorum may still have dropped the request. Must report unsettled and
    // leave the note spendable; the old balance poll said "settled" here.
    connection.balance = 1n
    const result = await drain(spend())

    expect(result.settled).toBe(false)
    expect(connection.balanceReads).toBe(0)
    expect((await getNotes(ACCOUNT))[0].spent).toBe(false)
    expect(await shieldedBalance(ACCOUNT)).toBe(INPUT_AMOUNT)
  })

  it("confirms a genuine settlement and books the change from the tree", async () => {
    // The false negative: the change commitment landing is the settlement, and
    // it confirms even though no recipient balance is read at all.
    const pending = spend()
    const change = await changeCommitment(pending)
    tree.leaves = [{ commitmentHex: INPUT }, { commitmentHex: change }]

    const result = await drain(pending)

    expect(result.settled).toBe(true)
    expect(connection.balanceReads).toBe(0)
    const notes = await getNotes(ACCOUNT)
    expect(notes.find((n) => n.commitment === INPUT)!.spent).toBe(true)
    const booked = notes.find((n) => n.commitment === change)
    expect(booked).toBeDefined()
    expect(booked!.amount).toBe(CHANGE.toString())
    expect(booked!.spent).toBe(false)
  })

  it("keeps polling through a transient RPC error instead of aborting", async () => {
    // A dropped rebuild after submission used to throw out of spendV3, skipping
    // the bookkeeping that marks the inputs spent and stranding the change
    // blinding (the note's only copy).
    tree.fetchThrows = 2
    const pending = spend()
    const change = await changeCommitment(pending)
    tree.leaves = [{ commitmentHex: INPUT }, { commitmentHex: change }]

    const result = await drain(pending)

    expect(result.settled).toBe(true)
    const notes = await getNotes(ACCOUNT)
    expect(notes.find((n) => n.commitment === INPUT)!.spent).toBe(true)
    expect(notes.find((n) => n.commitment === change)!.blinding).toBeTruthy()
  })
})

describe("a caller-supplied confirmSettled is hardened too", () => {
  // The exact predicate the popup used to pass: `getSolBalance(...) > before`,
  // polled every 2s. It is the "before" half of the contrast below.
  function balanceDeltaPoll(before: bigint): () => Promise<boolean> {
    return async () => {
      await new Promise((r) => setTimeout(r, 2_000))
      return (await connection.getBalance()) > before
    }
  }

  it("shows the old balance predicate false-confirming on an unrelated inflow", async () => {
    // Not a regression test of the new code but of the contrast: the tree is
    // untouched, only the recipient balance moved, and the balance predicate
    // still answers true. This is the bug the popup override had.
    const before = connection.balance
    const withBalance = spend(balanceDeltaPoll(before))
    connection.balance = before + 1n // unrelated inflow, nothing in the tree
    const balanceResult = await drain(withBalance)

    // Same spend, same tree, no balance predicate — correctly unsettled.
    const withTree = await drain(spend())

    expect(balanceResult.settled).toBe(true)
    expect(withTree.settled).toBe(false)
  })

  it("does not abort when the predicate throws after submission", async () => {
    let calls = 0
    const result = await drain(
      spend(async () => {
        calls += 1
        if (calls === 1) throw new Error("RPC 502")
        return true
      })
    )

    expect(result.settled).toBe(true)
    expect(calls).toBe(2)
    expect((await getNotes(ACCOUNT))[0].spent).toBe(true)
  })

  it("reports unsettled, and books nothing, when the predicate never succeeds", async () => {
    let calls = 0
    const result = await drain(
      spend(async () => {
        calls += 1
        throw new Error("RPC 502")
      })
    )

    expect(result.settled).toBe(false)
    expect(calls).toBeGreaterThan(1)
    expect((await getNotes(ACCOUNT))[0].spent).toBe(false)
    expect(await shieldedBalance(ACCOUNT)).toBe(INPUT_AMOUNT)
  })
})
