// Notes are keyed by shielded address alone, but the SAME shielded address
// exists on both clusters: the program id is identical on mainnet-beta and
// devnet, and the account seed is identical too, so switching the network in
// the UI points the same note list at a different on-chain tree.
//
// A note deposited on devnet therefore shows up in the mainnet shielded
// balance, `spendV3` picks it, and `ensureLeafIndex` looks its commitment up in
// the MAINNET tree — where it never lands. The spend dies with "note
// commitment not found in the on-chain tree" instead of using the note the
// user actually has on that cluster.
import { addNote, getNotes, shieldedBalance, shieldedTokenBalances, type ShieldedNote } from "~lib/paraloom/notes"
import { getNetwork, setNetwork } from "~lib/storage/network"
import { beforeEach, describe, expect, it } from "vitest"
import { installFakeChrome } from "./support/chromeStorage"

const ACCOUNT = "paraloom1" + "11".repeat(64)

function note(amount: string, overrides: Partial<ShieldedNote> = {}): ShieldedNote {
  return {
    amount,
    blinding: "aa".repeat(32),
    assetId: "00".repeat(32),
    signature: `sig-${amount}`,
    createdAt: 1,
    spent: false,
    source: "deposit",
    ...overrides
  }
}

beforeEach(() => {
  installFakeChrome()
})

describe("note storage is scoped to the selected cluster", () => {
  it("keeps a devnet deposit out of the mainnet balance", async () => {
    await setNetwork("devnet")
    await addNote(ACCOUNT, note("500000000"))

    await setNetwork("mainnet-beta")
    expect(await getNotes(ACCOUNT)).toEqual([])
    expect(await shieldedBalance(ACCOUNT)).toBe(0n)

    await setNetwork("devnet")
    expect(await shieldedBalance(ACCOUNT)).toBe(500000000n)
  })

  it("does not leak SPL balances across clusters", async () => {
    const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    await setNetwork("devnet")
    await addNote(ACCOUNT, note("1000000", { assetId: "ab".repeat(32), mint: usdc }))

    await setNetwork("mainnet-beta")
    expect(await shieldedTokenBalances(ACCOUNT)).toEqual({})

    await setNetwork("devnet")
    expect(await shieldedTokenBalances(ACCOUNT)).toEqual({ [usdc]: 1000000n })
  })

  it("scopes to the resolved default (mainnet-beta) before any explicit choice", async () => {
    expect(await getNetwork()).toBe("mainnet-beta")
    await addNote(ACCOUNT, note("7"))
    expect(await shieldedBalance(ACCOUNT)).toBe(7n)
  })
})

describe("legacy pre-cluster data survives the migration", () => {
  it("adopts a flat legacy bucket into the selected cluster without losing notes", async () => {
    // Shape written by every build before this change: bare address -> notes.
    await chrome.storage.local.set({
      paraloom_notes: {
        [ACCOUNT]: [note("123000")],
      },
    })
    await setNetwork("devnet")

    expect(await shieldedBalance(ACCOUNT)).toBe(123000n)

    // Replaced by the clustered shape on first read, not duplicated: a later
    // network switch must not find a stale flat bucket to re-adopt.
    const raw = (await chrome.storage.local.get("paraloom_notes")).paraloom_notes
    expect(raw.pendingNetwork).toBeUndefined()
    expect(raw.devnet[ACCOUNT]).toHaveLength(1)

    await setNetwork("mainnet-beta")
    expect(await shieldedBalance(ACCOUNT)).toBe(0n)
  })

  it("keeps a write after migration on the selected cluster only", async () => {
    await chrome.storage.local.set({ paraloom_notes: { [ACCOUNT]: [note("1")] } })
    await setNetwork("devnet")
    await addNote(ACCOUNT, note("2"))

    const raw = (await chrome.storage.local.get("paraloom_notes")).paraloom_notes
    expect(raw.devnet[ACCOUNT]).toHaveLength(2)
    expect(raw["mainnet-beta"]).toBeUndefined()
  })
})
