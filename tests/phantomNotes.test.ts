import { beforeEach, describe, expect, it, vi } from "vitest"

import { addDiscoveredNote, addNote, getNotes } from "~lib/paraloom/notes"
import {
  dropPhantomNotes,
  PHANTOM_GRACE_MS
} from "~lib/paraloom/phantomNotes"
import { installFakeChrome } from "./support/chromeStorage"

// phantomNotes -> transact.ts -> bridge.ts -> ~lib/prover (wasm); the wasm
// module cannot load under vitest. Nothing under test uses it. Same shim the
// transact tests pin.
vi.mock("~lib/prover", () => ({ NATIVE_ASSET_HEX: "00".repeat(32) }))

const ACCOUNT = "paraloom1" + "11".repeat(64)

const NATIVE = "00".repeat(32)
const USDC_ASSET = "11".repeat(32)

function receivedNative(commitment: string, overrides = {}) {
  return {
    amount: "1000000000",
    blinding: "aa".repeat(32),
    assetId: NATIVE,
    signature: "",
    createdAt: 1,
    spent: false,
    commitment,
    source: "transfer" as const,
    ...overrides
  }
}

function receivedSpl(commitment: string, overrides = {}) {
  return {
    amount: "50000000",
    blinding: "bb".repeat(32),
    assetId: USDC_ASSET,
    signature: "",
    createdAt: 1,
    spent: false,
    commitment,
    source: "transfer" as const,
    ...overrides
  }
}

// dropPhantomNotes reaches fetchV3Leaves(connection); stub it via vi.mock on
// the transact module.
vi.mock("~lib/paraloom/transact", async (importOriginal) => {
  const mod: any = await importOriginal()
  return {
    ...mod,
    fetchV3Leaves: vi.fn(async () =>
      (globalThis as any).__onchainLeaves.map((c: string) => ({
        index: 0,
        commitmentHex: c
      }))
    )
  }
})

beforeEach(() => {
  installFakeChrome()
  ;(globalThis as any).__onchainLeaves = []
})

describe("dropPhantomNotes", () => {
  it("drops a stale received note whose commitment is absent from the tree", async () => {
    ;(globalThis as any).__onchainLeaves = ["cc".repeat(32)]
    await addDiscoveredNote(ACCOUNT, receivedNative("ab".repeat(32)))

    const notes = await getNotes(ACCOUNT)
    const kept = await dropPhantomNotes({} as never, ACCOUNT, notes)

    expect(kept).toHaveLength(0)
    const after = await getNotes(ACCOUNT)
    expect(after[0].spent).toBe(true) // soft mark-spent: record + blinding kept
  })

  it("keeps a fresh (inside grace) note even if the tree does not show it yet", async () => {
    ;(globalThis as any).__onchainLeaves = []
    await addDiscoveredNote(
      ACCOUNT,
      receivedNative("ab".repeat(32), { createdAt: Date.now() })
    )

    const notes = await getNotes(ACCOUNT)
    const kept = await dropPhantomNotes({} as never, ACCOUNT, notes)
    expect(kept).toHaveLength(1)
  })

  it("keeps a note whose commitment is present in the tree", async () => {
    ;(globalThis as any).__onchainLeaves = ["ab".repeat(32)]
    await addDiscoveredNote(ACCOUNT, receivedNative("ab".repeat(32)))

    const notes = await getNotes(ACCOUNT)
    const kept = await dropPhantomNotes({} as never, ACCOUNT, notes)
    expect(kept).toHaveLength(1)
  })

  it("never touches deposit notes (trusted on-chain leafIndex)", async () => {
    ;(globalThis as any).__onchainLeaves = []
    await addNote(ACCOUNT, {
      amount: "2000000000",
      blinding: "cc".repeat(32),
      assetId: NATIVE,
      signature: "sig-dep",
      createdAt: 1,
      spent: false,
      source: "deposit"
    })

    const notes = await getNotes(ACCOUNT)
    const kept = await dropPhantomNotes({} as never, ACCOUNT, notes)
    expect(kept).toHaveLength(1)
  })

  it("does not throw when the tree rebuild fails; drops nothing", async () => {
    ;(globalThis as any).__onchainLeaves = undefined // mock will throw on map
    await addDiscoveredNote(ACCOUNT, receivedNative("ab".repeat(32)))

    const notes = await getNotes(ACCOUNT)
    const kept = await dropPhantomNotes({} as never, ACCOUNT, notes)
    expect(kept).toHaveLength(1)
  })
})

describe("token-input swap candidates (#857 asymmetry)", () => {
  it("a phantom SPL note is healed by the same helper the native path uses", async () => {
    ;(globalThis as any).__onchainLeaves = ["cc".repeat(32)]
    // One phantom SPL note (never landed) + one real SPL note.
    await addDiscoveredNote(ACCOUNT, receivedSpl("ab".repeat(32)))
    await addDiscoveredNote(ACCOUNT, receivedSpl("cc".repeat(32)))

    const notes = await getNotes(ACCOUNT)
    const tokenCandidates = notes.filter((n) => n.assetId === USDC_ASSET)
    const healed = await dropPhantomNotes({} as never, ACCOUNT, tokenCandidates)

    expect(healed).toHaveLength(1)
    expect(healed[0].commitment).toBe("cc".repeat(32))
  })

  it("grace window constant matches the settlement budget used elsewhere", () => {
    expect(PHANTOM_GRACE_MS).toBe(120_000)
  })
})
