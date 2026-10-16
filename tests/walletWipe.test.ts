import { addNote, getNotes } from "~lib/paraloom/notes"
import { listSwapOutputs, saveSwapOutput } from "~lib/paraloom/swapOutputs"
import { addApprovedOrigin, getApprovedOrigins, isOriginApproved } from "~lib/storage/connections"
import { clearWallet, getStoredWallet, saveEncryptedWallet } from "~lib/storage/secure"
import { clearSession, getLastActivity, loadSession, saveSession } from "~lib/storage/session"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { installFakeChrome, type FakeChrome } from "./support/chromeStorage"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  v3NotePubkey: vi.fn(async () => "00".repeat(32))
}))

const OLD_ACCOUNT = "paraloom1" + "aa".repeat(64)

let fakeChrome: FakeChrome

beforeEach(() => {
  fakeChrome = installFakeChrome()
})

describe("clearWallet and clearSession full state wipe", () => {
  it("wipes swap secret keys, approved dApp origins, shielded notes, and session state on clearWallet", async () => {
    await saveEncryptedWallet(
      { encrypted: "11", nonce: "22", salt: "33" },
      OLD_ACCOUNT,
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      "password123"
    )
    await addNote(OLD_ACCOUNT, {
      amount: "500000000",
      blinding: "bb".repeat(32),
      assetId: "00".repeat(32),
      signature: "sig_old_deposit",
      createdAt: 1700000000000,
      spent: false,
      source: "deposit"
    })
    await saveSwapOutput({
      freshAddress: "Fresh11111111111111111111111111111111111111",
      freshSecretKeyHex: "cc".repeat(64),
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outAmount: 1000000,
      swapSignature: "",
      reshield: true,
      createdAt: 1700000000000
    })
    await addApprovedOrigin("https://app.paraloom.io")

    const kp = {
      publicKey: new Uint8Array(32).fill(1),
      secretKey: new Uint8Array(64).fill(2),
      shieldedAddress: OLD_ACCOUNT,
      boxPublicKey: new Uint8Array(32).fill(3),
      boxSecretKey: new Uint8Array(32).fill(4),
      spendPrivkey: new Uint8Array(32).fill(5)
    }
    await saveSession({
      wallet: kp,
      accounts: [{ index: 0, name: "Account 1", keypair: kp, balance: 0n }],
      currentAccountIndex: 0,
      seedPhrase: "test seed"
    })
    await fakeChrome.storage.session.set({
      pendingConn: { id: 1, origin: "https://app.paraloom.io" },
      swapJob: { status: "pending", startedAt: Date.now() }
    })

    // Sanity check before wipe
    expect(await getStoredWallet()).not.toBeNull()
    expect(await getNotes(OLD_ACCOUNT)).toHaveLength(1)
    expect(await listSwapOutputs()).toHaveLength(1)
    expect(await isOriginApproved("https://app.paraloom.io")).toBe(true)
    expect(await loadSession()).not.toBeNull()

    await clearWallet()

    // Every wallet-bound store in local and session storage must be gone
    expect(await getStoredWallet()).toBeNull()
    expect(await getNotes(OLD_ACCOUNT)).toEqual([])
    expect(await listSwapOutputs()).toEqual([])
    expect(await getApprovedOrigins()).toEqual([])
    expect(await isOriginApproved("https://app.paraloom.io")).toBe(false)
    expect(await loadSession()).toBeNull()
    expect(await getLastActivity()).toBeNull()
    expect(fakeChrome.storage.session.raw.pendingConn).toBeUndefined()
    expect(fakeChrome.storage.session.raw.swapJob).toBeUndefined()
  })

  it("removes pendingConn alongside the unlocked session and activity timestamp on clearSession", async () => {
    const kp = {
      publicKey: new Uint8Array(32).fill(1),
      secretKey: new Uint8Array(64).fill(2),
      shieldedAddress: OLD_ACCOUNT,
      boxPublicKey: new Uint8Array(32).fill(3),
      boxSecretKey: new Uint8Array(32).fill(4),
      spendPrivkey: new Uint8Array(32).fill(5)
    }
    await saveSession({
      wallet: kp,
      accounts: [{ index: 0, name: "Account 1", keypair: kp, balance: 0n }],
      currentAccountIndex: 0,
      seedPhrase: null
    })
    await fakeChrome.storage.session.set({
      pendingConn: { id: 7, origin: "https://swaps.paraloom.io" }
    })

    await clearSession()

    expect(await loadSession()).toBeNull()
    expect(await getLastActivity()).toBeNull()
    expect(fakeChrome.storage.session.raw.pendingConn).toBeUndefined()
  })
})
