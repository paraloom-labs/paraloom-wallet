import type { Connection } from "@solana/web3.js"
import { addNote, getNotes, type ShieldedNote } from "~lib/paraloom/notes"
import { dropPhantomNotes, PHANTOM_GRACE_MS } from "~lib/paraloom/phantomNotes"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { installFakeChrome } from "./support/chromeStorage"

const mocks = vi.hoisted(() => ({
  fetchV3Leaves: vi.fn()
}))
vi.mock("~/lib/paraloom/transact", () => ({
  fetchV3Leaves: mocks.fetchV3Leaves
}))

const ACCOUNT = "paraloom1" + "11".repeat(64)
const TOKEN_ASSET = "ab".repeat(32)
const PHANTOM_COMMITMENT = "dd".repeat(32)
const LANDED_COMMITMENT = "ee".repeat(32)

// The token-path shape from the regression: a received SPL note with no
// deposit signature, located only by commitment, created before the grace
// window, whose commitment never landed in the on-chain tree.
function tokenNote(overrides: Partial<ShieldedNote> = {}): ShieldedNote {
  return {
    amount: "5000000",
    blinding: "cc".repeat(32),
    assetId: TOKEN_ASSET,
    signature: "",
    createdAt: Date.now() - PHANTOM_GRACE_MS - 1,
    spent: false,
    commitment: PHANTOM_COMMITMENT,
    source: "transfer",
    ...overrides
  }
}

const connection = {} as Connection

beforeEach(() => {
  installFakeChrome()
  mocks.fetchV3Leaves.mockReset()
})

describe("dropPhantomNotes (token-path heal)", () => {
  it("drops a stale phantom note that is not in the on-chain tree and persists it spent", async () => {
    // The tree contains the landed note only — the phantom's commitment never
    // settled. Selecting the phantom would brick the swap at ensureLeafIndex.
    mocks.fetchV3Leaves.mockResolvedValue([{ commitmentHex: LANDED_COMMITMENT }])
    const phantom = tokenNote()
    const landed = tokenNote({ commitment: LANDED_COMMITMENT })
    await addNote(ACCOUNT, phantom)
    await addNote(ACCOUNT, landed)

    const healed = await dropPhantomNotes(connection, ACCOUNT, [phantom, landed])

    expect(mocks.fetchV3Leaves).toHaveBeenCalledTimes(1)
    expect(healed.map((n) => n.commitment)).toEqual([LANDED_COMMITMENT])

    // Soft mark-spent: the record survives so a re-scan can resolve it later.
    const stored = await getNotes(ACCOUNT)
    expect(stored.find((n) => n.commitment === PHANTOM_COMMITMENT)?.spent).toBe(true)
    expect(stored.find((n) => n.commitment === LANDED_COMMITMENT)?.spent).toBe(false)
  })

  it("keeps a suspect whose commitment IS in the on-chain tree", async () => {
    mocks.fetchV3Leaves.mockResolvedValue([{ commitmentHex: PHANTOM_COMMITMENT }])
    const note = tokenNote()
    await addNote(ACCOUNT, note)

    const healed = await dropPhantomNotes(connection, ACCOUNT, [note])

    expect(healed).toEqual([note])
    const stored = await getNotes(ACCOUNT)
    expect(stored.find((n) => n.commitment === PHANTOM_COMMITMENT)?.spent).toBe(false)
  })

  it("never checks notes that carry a trusted on-chain leafIndex", async () => {
    const deposit = tokenNote({ leafIndex: 7 })

    const healed = await dropPhantomNotes(connection, ACCOUNT, [deposit])

    expect(healed).toEqual([deposit])
    expect(mocks.fetchV3Leaves).not.toHaveBeenCalled()
  })

  it("never checks notes still inside the settlement grace window", async () => {
    const fresh = tokenNote({ createdAt: Date.now() })

    const healed = await dropPhantomNotes(connection, ACCOUNT, [fresh])

    expect(healed).toEqual([fresh])
    expect(mocks.fetchV3Leaves).not.toHaveBeenCalled()
  })

  it("drops nothing when the on-chain tree cannot be fetched", async () => {
    mocks.fetchV3Leaves.mockRejectedValue(new Error("rpc down"))
    const phantom = tokenNote()
    await addNote(ACCOUNT, phantom)

    const healed = await dropPhantomNotes(connection, ACCOUNT, [phantom])

    // Soft-fail: with the tree unavailable the heuristic cannot distinguish a
    // phantom from a note that settled a moment ago, so nothing is dropped.
    expect(healed).toEqual([phantom])
    const stored = await getNotes(ACCOUNT)
    expect(stored.find((n) => n.commitment === PHANTOM_COMMITMENT)?.spent).toBe(false)
  })
})
