import { beforeEach, describe, expect, it } from "vitest"
import { loadSession, saveSession, type WalletSession } from "~lib/storage/session"
import { installFakeChrome, type FakeChrome } from "./support/chromeStorage"

function sampleSession(): WalletSession {
  const wallet = {
    publicKey: new Uint8Array(32).fill(0x11),
    secretKey: new Uint8Array(64).fill(0x22),
    shieldedAddress: "paraloom1" + "aa".repeat(68),
    boxPublicKey: new Uint8Array(32).fill(0x33),
    boxSecretKey: new Uint8Array(32).fill(0x44),
    spendPrivkey: new Uint8Array(32).fill(0x55)
  }
  return {
    wallet,
    accounts: [
      {
        index: 0,
        name: "Account 1",
        keypair: wallet,
        balance: 1_000_000_000n
      }
    ],
    currentAccountIndex: 0,
    seedPhrase: "test seed phrase"
  }
}

describe("session storage validation (#232)", () => {
  let chrome: FakeChrome

  beforeEach(() => {
    chrome = installFakeChrome()
  })

  it("round-trips a valid WalletSession", async () => {
    const original = sampleSession()
    await saveSession(original)
    const loaded = await loadSession()
    expect(loaded).toEqual(original)
  })

  it("clears and returns null when session storage contains malformed hex or truncated keys", async () => {
    await chrome.storage.session.set({
      paraloom_session: {
        wallet: {
          publicKey: "zz".repeat(32),
          secretKey: "22".repeat(64),
          shieldedAddress: "paraloom1" + "aa".repeat(68),
          boxPublicKey: "33".repeat(32),
          boxSecretKey: "44".repeat(32),
          spendPrivkey: "55".repeat(32)
        },
        accounts: [],
        currentAccountIndex: 0,
        seedPhrase: null
      }
    })
    expect(await loadSession()).toBeNull()
    expect(chrome.storage.session.raw.paraloom_session).toBeUndefined()
  })

  it("clears and returns null when session accounts or balance are corrupted", async () => {
    await chrome.storage.session.set({
      paraloom_session: {
        wallet: null,
        accounts: "not-an-array"
      }
    })
    expect(await loadSession()).toBeNull()
    expect(chrome.storage.session.raw.paraloom_session).toBeUndefined()
  })
})
