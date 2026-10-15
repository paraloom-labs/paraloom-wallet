import {
  addDiscoveredNote,
  addNote,
  getNotes,
  isNativeSolNote,
  markNoteSpentByIdentity,
  PHANTOM_NOTE_GRACE_MS,
  reconcilePhantomNotes,
  selectNativeSolNotes,
  shieldedBalance,
  shieldedTokenBalances,
  type ShieldedNote
} from "~lib/paraloom/notes"
import { beforeEach, describe, expect, it } from "vitest"
import { installFakeChrome } from "./support/chromeStorage"

const ACCOUNT = "paraloom1" + "11".repeat(64)
const OTHER_ACCOUNT = "paraloom1" + "22".repeat(64)

function deposit(overrides: Partial<ShieldedNote> = {}): ShieldedNote {
  return {
    amount: "1000",
    blinding: "aa".repeat(32),
    assetId: "00".repeat(32),
    signature: "sig-deposit",
    createdAt: 1,
    spent: false,
    source: "deposit",
    ...overrides
  }
}

function received(commitment: string, overrides: Partial<ShieldedNote> = {}): ShieldedNote {
  return {
    amount: "2000",
    blinding: "bb".repeat(32),
    assetId: "00".repeat(32),
    signature: "", // received notes have no deposit signature
    createdAt: 2,
    spent: false,
    commitment,
    source: "transfer",
    ...overrides
  }
}

beforeEach(() => {
  installFakeChrome()
})

describe("markNoteSpentByIdentity (#718)", () => {
  it("spends only the named received note, leaving the other received notes alone", async () => {
    // The bug: received and change notes all carry `signature: ""`, so
    // matching on signature flipped every one of them at once. Both notes
    // below are indistinguishable by signature and must not share a fate.
    const a = received("c0".repeat(32))
    const b = received("c1".repeat(32))
    await addDiscoveredNote(ACCOUNT, a)
    await addDiscoveredNote(ACCOUNT, b)

    await markNoteSpentByIdentity(ACCOUNT, a)

    const notes = await getNotes(ACCOUNT)
    expect(notes.find((n) => n.commitment === a.commitment)!.spent).toBe(true)
    expect(notes.find((n) => n.commitment === b.commitment)!.spent).toBe(false)
  })

  it("keeps the balance of the surviving notes", async () => {
    // The user-visible symptom was notes vanishing from the balance and not
    // coming back on re-scan, so assert the number, not just the flag.
    await addDiscoveredNote(ACCOUNT, received("c0".repeat(32)))
    await addDiscoveredNote(ACCOUNT, received("c1".repeat(32)))
    await addNote(ACCOUNT, deposit())

    await markNoteSpentByIdentity(ACCOUNT, received("c0".repeat(32)))

    expect(await shieldedBalance(ACCOUNT)).toBe(3000n)
  })

  it("spends a deposit note by signature when it has no commitment", async () => {
    await addNote(ACCOUNT, deposit({ signature: "sig-a" }))
    await addNote(ACCOUNT, deposit({ signature: "sig-b" }))

    await markNoteSpentByIdentity(ACCOUNT, deposit({ signature: "sig-a" }))

    const notes = await getNotes(ACCOUNT)
    expect(notes.find((n) => n.signature === "sig-a")!.spent).toBe(true)
    expect(notes.find((n) => n.signature === "sig-b")!.spent).toBe(false)
  })

  it("prefers the commitment when a note carries both identities", async () => {
    // A change note that also happens to carry a signature must not fall
    // through to the signature branch and take its siblings with it.
    await addDiscoveredNote(ACCOUNT, received("c0".repeat(32), { signature: "shared" }))
    await addDiscoveredNote(ACCOUNT, received("c1".repeat(32), { signature: "shared" }))

    await markNoteSpentByIdentity(ACCOUNT, received("c0".repeat(32), { signature: "shared" }))

    // Naming both notes, not just counting: a count of one is also what
    // spending the wrong note produces.
    const notes = await getNotes(ACCOUNT)
    expect(notes.find((n) => n.commitment === "c0".repeat(32))!.spent).toBe(true)
    expect(notes.find((n) => n.commitment === "c1".repeat(32))!.spent).toBe(false)
  })

  it("is a no-op for a note with neither identity", async () => {
    await addNote(ACCOUNT, deposit({ signature: "" }))
    await markNoteSpentByIdentity(ACCOUNT, deposit({ signature: "" }))
    expect((await getNotes(ACCOUNT)).every((n) => !n.spent)).toBe(true)
  })
})

describe("shielded token notes (#779)", () => {
  // Native and SPL notes live in one list and are told apart only by `mint`.
  // A note counted on the wrong side is a silent balance error, in a number
  // the user acts on.
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

  it("keeps an SPL note out of the native balance", async () => {
    await addNote(ACCOUNT, deposit({ signature: "s1" }))
    await addNote(ACCOUNT, deposit({ signature: "s2", mint: USDC, amount: "500" }))
    expect(await shieldedBalance(ACCOUNT)).toBe(1000n)
  })

  it("keeps a native note out of the token balances", async () => {
    await addNote(ACCOUNT, deposit({ signature: "s1" }))
    expect(await shieldedTokenBalances(ACCOUNT)).toEqual({})
  })

  it("sums each mint separately", async () => {
    await addNote(ACCOUNT, deposit({ signature: "s1", mint: USDC, amount: "500" }))
    await addNote(ACCOUNT, deposit({ signature: "s2", mint: USDC, amount: "250" }))
    await addNote(
      ACCOUNT,
      deposit({ signature: "s3", mint: "So11111111111111111111111111111111111111112", amount: "7" })
    )
    expect(await shieldedTokenBalances(ACCOUNT)).toEqual({
      [USDC]: 750n,
      So11111111111111111111111111111111111111112: 7n
    })
  })

  it("drops a mint once its last note is spent", async () => {
    // An empty entry reads as a token the wallet still holds.
    await addNote(ACCOUNT, deposit({ signature: "s1", mint: USDC, amount: "500", spent: true }))
    expect(await shieldedTokenBalances(ACCOUNT)).toEqual({})
  })

  it("spends an SPL note without touching a native one of the same amount", async () => {
    const spl = received("c0".repeat(32), { mint: USDC })
    await addDiscoveredNote(ACCOUNT, spl)
    await addDiscoveredNote(ACCOUNT, received("c1".repeat(32)))

    await markNoteSpentByIdentity(ACCOUNT, spl)

    expect(await shieldedTokenBalances(ACCOUNT)).toEqual({})
    expect(await shieldedBalance(ACCOUNT)).toBe(2000n)
  })
})

describe("note storage", () => {
  it("de-duplicates discovered notes by commitment, keeping the first copy", async () => {
    // Which copy survives is the part that matters, not just the count:
    // first-wins, last-wins and field-merge all keep the length at one, and
    // #718 is about spent state surviving a re-scan. First-wins means a
    // re-delivered note cannot quietly overwrite `spent` either.
    const note = received("c0".repeat(32))
    await addDiscoveredNote(ACCOUNT, note)
    await addDiscoveredNote(ACCOUNT, { ...note, createdAt: 99, amount: "5000" })

    const notes = await getNotes(ACCOUNT)
    expect(notes).toHaveLength(1)
    expect(notes[0].createdAt).toBe(2)
    expect(notes[0].amount).toBe("2000")
  })

  it("does not resurrect a spent note on re-scan", async () => {
    const note = received("c0".repeat(32))
    await addDiscoveredNote(ACCOUNT, note)
    await markNoteSpentByIdentity(ACCOUNT, note)
    await addDiscoveredNote(ACCOUNT, note) // the node delivers it again

    expect((await getNotes(ACCOUNT))[0].spent).toBe(true)
    expect(await shieldedBalance(ACCOUNT)).toBe(0n)
  })

  it("keeps accounts separate", async () => {
    await addNote(ACCOUNT, deposit())
    expect(await getNotes(OTHER_ACCOUNT)).toEqual([])
    expect(await shieldedBalance(OTHER_ACCOUNT)).toBe(0n)
  })

  it("sums lamports as bigint, not as a float", async () => {
    // Above 2^53 a Number sum silently loses precision; these two amounts
    // differ by 1 lamport and must not collapse to the same total.
    await addNote(ACCOUNT, deposit({ amount: "9007199254740993", signature: "s1" }))
    await addNote(ACCOUNT, deposit({ amount: "1", signature: "s2" }))
    expect(await shieldedBalance(ACCOUNT)).toBe(9007199254740994n)
  })

  it("excludes spent notes from the balance", async () => {
    await addNote(ACCOUNT, deposit({ signature: "s1" }))
    await addNote(ACCOUNT, deposit({ signature: "s2", spent: true }))
    expect(await shieldedBalance(ACCOUNT)).toBe(1000n)
  })
})

describe("selectNativeSolNotes & reconcilePhantomNotes", () => {
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  const USDC_ASSET = "dd".repeat(32)

  it("never selects SPL token notes when choosing inputs for a native SOL transfer", () => {
    const splNote = deposit({
      signature: "spl-1",
      amount: "2000000000", // 2,000 USDC raw units
      assetId: USDC_ASSET,
      mint: USDC
    })
    const solNote1 = deposit({
      signature: "sol-1",
      amount: "600000000" // 0.6 SOL
    })
    const solNote2 = deposit({
      signature: "sol-2",
      amount: "500000000" // 0.5 SOL
    })

    expect(isNativeSolNote(splNote)).toBe(false)
    expect(isNativeSolNote(solNote1)).toBe(true)

    const chosen = selectNativeSolNotes(
      [splNote, solNote1, solNote2],
      1_000_000_000n
    )
    expect(chosen).not.toBeNull()
    expect(chosen!.map((n) => n.signature)).toEqual(["sol-1", "sol-2"])
  })

  it("reconciles out phantom notes absent from the on-chain tree after the grace window", async () => {
    const now = 500_000
    const phantom = received("aa".repeat(32), {
      amount: "5000",
      createdAt: now - PHANTOM_NOTE_GRACE_MS - 1
    })
    const settled = received("bb".repeat(32), {
      amount: "3000",
      createdAt: now - PHANTOM_NOTE_GRACE_MS - 1
    })
    const fresh = received("cc".repeat(32), {
      amount: "4000",
      createdAt: now - 1_000
    })

    await addDiscoveredNote(ACCOUNT, phantom)
    await addDiscoveredNote(ACCOUNT, settled)
    await addDiscoveredNote(ACCOUNT, fresh)

    const remaining = await reconcilePhantomNotes(
      ACCOUNT,
      await getNotes(ACCOUNT),
      async () => [{ commitmentHex: "bb".repeat(32) }],
      now
    )

    expect(remaining.map((n) => n.commitment)).toEqual([
      "bb".repeat(32),
      "cc".repeat(32)
    ])
    expect(await shieldedBalance(ACCOUNT)).toBe(7000n)
  })
})

