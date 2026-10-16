import {
  addDiscoveredNote,
  addNote,
  getNotes,
  markNoteSpent,
  markNoteSpentByCommitment,
  setNoteLeafIndex,
  shieldedBalance,
  type ShieldedNote
} from "~lib/paraloom/notes"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { installFakeChrome, type FakeChrome } from "./support/chromeStorage"

const ACCOUNT = "synthetic-account-a"
const OTHER_ACCOUNT = "synthetic-account-b"

function note(signature: string, overrides: Partial<ShieldedNote> = {}): ShieldedNote {
  return {
    amount: "1000",
    blinding: "aa".repeat(32),
    assetId: "00".repeat(32),
    signature,
    createdAt: 1,
    spent: false,
    ...overrides
  }
}

let chrome: FakeChrome
beforeEach(() => {
  chrome = installFakeChrome()
})

describe("concurrent note mutations", () => {
  it("preserves two successful concurrent deposits", async () => {
    await Promise.all([addNote(ACCOUNT, note("first")), addNote(ACCOUNT, note("second"))])

    expect((await getNotes(ACCOUNT)).map((n) => n.signature).sort()).toEqual(["first", "second"])
    expect(await shieldedBalance(ACCOUNT)).toBe(2000n)
  })

  it("serializes across accounts because they share one storage key", async () => {
    await Promise.all([addNote(ACCOUNT, note("first")), addNote(OTHER_ACCOUNT, note("second"))])

    expect(await getNotes(ACCOUNT)).toEqual([note("first")])
    expect(await getNotes(OTHER_ACCOUNT)).toEqual([note("second")])
  })

  it("preserves concurrent discoveries", async () => {
    const first = note("", { commitment: "11".repeat(32), source: "transfer" })
    const second = note("", { commitment: "22".repeat(32), source: "transfer" })
    await Promise.all([addDiscoveredNote(ACCOUNT, first), addDiscoveredNote(ACCOUNT, second)])

    expect(await getNotes(ACCOUNT)).toEqual([first, second])
  })

  it("does not resurrect a spent note when another note arrives", async () => {
    await addNote(ACCOUNT, note("first"))
    await Promise.all([markNoteSpent(ACCOUNT, "first"), addNote(ACCOUNT, note("second"))])

    expect(await getNotes(ACCOUNT)).toEqual([note("first", { spent: true }), note("second")])
    expect(await shieldedBalance(ACCOUNT)).toBe(1000n)
  })

  it("keeps both spent flags when different note identities are marked concurrently", async () => {
    const commitment = "11".repeat(32)
    await addNote(ACCOUNT, note("first"))
    await addDiscoveredNote(ACCOUNT, note("", { commitment }))
    await Promise.all([
      markNoteSpent(ACCOUNT, "first"),
      markNoteSpentByCommitment(ACCOUNT, commitment)
    ])

    expect((await getNotes(ACCOUNT)).every((n) => n.spent)).toBe(true)
    expect(await shieldedBalance(ACCOUNT)).toBe(0n)
  })

  it("keeps a leaf-index update when another note arrives", async () => {
    const commitment = "11".repeat(32)
    await addNote(ACCOUNT, note("first", { commitment }))
    await Promise.all([setNoteLeafIndex(ACCOUNT, commitment, 7), addNote(ACCOUNT, note("second"))])

    expect(await getNotes(ACCOUNT)).toEqual([
      note("first", { commitment, leafIndex: 7 }),
      note("second")
    ])
  })

  it("coordinates independent module instances, not only calls in one context", async () => {
    vi.resetModules()
    const otherContext = await import("~lib/paraloom/notes")
    expect(otherContext.addNote).not.toBe(addNote)
    await Promise.all([
      addNote(ACCOUNT, note("popup")),
      otherContext.addNote(ACCOUNT, note("worker"))
    ])

    expect((await getNotes(ACCOUNT)).map((n) => n.signature).sort()).toEqual(["popup", "worker"])
  })

  it.each(["get", "set"] as const)(
    "propagates a failed %s and releases the next writer",
    async (method) => {
      vi.spyOn(chrome.storage.local, method).mockRejectedValueOnce(new Error("storage unavailable"))
      const failed = addNote(ACCOUNT, note("failed"))
      const next = addNote(ACCOUNT, note("next"))

      await expect(failed).rejects.toThrow("storage unavailable")
      await expect(next).resolves.toBeUndefined()
      expect(await getNotes(ACCOUNT)).toEqual([note("next")])
    }
  )
})
