// Regression tests for paraloom-wallet#138's lock/session desynchronization.
//
// `paraloom_wallet.locked` lives in disk storage while the decrypted session
// lives in memory-only chrome.storage.session. After a browser restart the flag
// can stay false with no session, and the old code treated that as unlocked —
// letting a dApp connect succeed without ever showing the unlock popup.

import { beforeEach, describe, expect, it, vi } from "vitest"

import { installFakeChrome } from "./support/chromeStorage"

const loadSession = vi.fn()
vi.mock("~lib/storage/session", () => ({
  loadSession: () => loadSession()
}))

// `secure.ts` pulls keyManagement, which imports the prover wasm; that cannot
// load under vitest and none of the lock-state code uses it.
vi.mock("~lib/prover", () => ({
  v3NotePubkey: vi.fn()
}))

import { reconcileEffectiveLockState } from "~lib/storage/lockState"

const WALLET_KEY = "paraloom_wallet"

function wallet(locked: boolean) {
  return {
    [WALLET_KEY]: {
      wallet: { address: "test-address", encryptedData: {}, createdAt: 1 },
      locked,
      autoLockMinutes: 60
    }
  }
}

describe("reconcileEffectiveLockState (#138)", () => {
  beforeEach(() => {
    installFakeChrome()
    loadSession.mockReset()
  })

  it("stays locked when the durable flag is true", async () => {
    const chrome = installFakeChrome()
    await chrome.storage.local.set(wallet(true))

    await expect(reconcileEffectiveLockState()).resolves.toBe(true)
    expect(loadSession).not.toHaveBeenCalled()
  })

  it("is unlocked only when the flag is false and a live session exists", async () => {
    const chrome = installFakeChrome()
    await chrome.storage.local.set(wallet(false))
    loadSession.mockResolvedValue({ wallet: {}, accounts: [], currentAccountIndex: 0, seedPhrase: null })

    await expect(reconcileEffectiveLockState()).resolves.toBe(false)
    expect(loadSession).toHaveBeenCalledOnce()
    expect((chrome.storage.local.raw[WALLET_KEY] as { locked: boolean }).locked).toBe(false)
  })

  it("repairs a stale unlocked flag when the session is gone", async () => {
    const chrome = installFakeChrome()
    await chrome.storage.local.set(wallet(false))
    loadSession.mockResolvedValue(null)

    await expect(reconcileEffectiveLockState()).resolves.toBe(true)
    expect((chrome.storage.local.raw[WALLET_KEY] as { locked: boolean }).locked).toBe(true)
  })

  it("locks when the stored session cannot be decoded", async () => {
    const chrome = installFakeChrome()
    await chrome.storage.local.set(wallet(false))
    loadSession.mockRejectedValue(new Error("corrupt session"))

    await expect(reconcileEffectiveLockState()).resolves.toBe(true)
    expect((chrome.storage.local.raw[WALLET_KEY] as { locked: boolean }).locked).toBe(true)
  })
})
