import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  v3NotePubkey: async () => "00".repeat(32)
}))

import {
  addApprovedOrigin,
  getApprovedOrigins,
  isOriginApproved,
  isSenderAuthorizedForOrigin,
  reconcileEffectiveLockState,
  removeApprovedOrigin,
  revokeOriginAuthorization
} from "~lib/storage/connections"
import { isWalletLocked, saveEncryptedWallet, setLockState } from "~lib/storage/secure"
import { clearSession, saveSession } from "~lib/storage/session"
import { installFakeChrome } from "./support/chromeStorage"

const ORIGIN_A = "https://app.paraloom.io"
const ORIGIN_B = "https://swap.paraloom.io"

function dummySession() {
  const bytes32 = new Uint8Array(32).fill(7)
  const bytes64 = new Uint8Array(64).fill(9)
  const kp = {
    publicKey: bytes32,
    secretKey: bytes64,
    shieldedAddress: "paraloom1" + "11".repeat(64) + "deadbeef",
    boxPublicKey: bytes32,
    boxSecretKey: bytes32,
    spendPrivkey: bytes32
  }
  return {
    wallet: kp,
    accounts: [{ index: 0, name: "Account 1", keypair: kp, balance: 0n }],
    currentAccountIndex: 0,
    seedPhrase: null
  }
}

beforeEach(() => {
  installFakeChrome()
})

describe("origin revocation & authorization enforcement", () => {
  it("denies authorization immediately after an origin is revoked in Settings", async () => {
    await addApprovedOrigin(ORIGIN_A)
    expect(await isSenderAuthorizedForOrigin(ORIGIN_A)).toBe(true)

    await removeApprovedOrigin(ORIGIN_A)
    expect(await isSenderAuthorizedForOrigin(ORIGIN_A)).toBe(false)
    expect(await isSenderAuthorizedForOrigin(null)).toBe(false)
  })

  it("clears connectedOrigin and rejects in-flight connection/swap requests for the revoked origin", async () => {
    await addApprovedOrigin(ORIGIN_A)
    await addApprovedOrigin(ORIGIN_B)

    const resolveConn = vi.fn()
    const resolveSwap = vi.fn()

    const next = await revokeOriginAuthorization(ORIGIN_A, {
      connectedOrigin: ORIGIN_A,
      pendingConnection: { id: 1, origin: ORIGIN_A, resolve: resolveConn },
      pendingSwap: { id: 2, origin: ORIGIN_A, resolve: resolveSwap }
    })

    expect(next.connectedOrigin).toBeNull()
    expect(resolveConn).toHaveBeenCalledWith(false)
    expect(resolveSwap).toHaveBeenCalledWith(false)
    expect(await isOriginApproved(ORIGIN_A)).toBe(false)
    expect(await isOriginApproved(ORIGIN_B)).toBe(true)
    expect(await getApprovedOrigins()).toEqual([ORIGIN_B])
  })

  it("preserves connectedOrigin and pending requests belonging to a different origin", async () => {
    await addApprovedOrigin(ORIGIN_A)
    await addApprovedOrigin(ORIGIN_B)

    const resolveConnB = vi.fn()
    const resolveSwapB = vi.fn()

    const next = await revokeOriginAuthorization(ORIGIN_A, {
      connectedOrigin: ORIGIN_B,
      pendingConnection: { id: 1, origin: ORIGIN_B, resolve: resolveConnB },
      pendingSwap: { id: 2, origin: ORIGIN_B, resolve: resolveSwapB }
    })

    expect(next.connectedOrigin).toBe(ORIGIN_B)
    expect(resolveConnB).not.toHaveBeenCalled()
    expect(resolveSwapB).not.toHaveBeenCalled()
    expect(await isSenderAuthorizedForOrigin(ORIGIN_A)).toBe(false)
    expect(await isSenderAuthorizedForOrigin(ORIGIN_B)).toBe(true)
  })
})

describe("reconcileEffectiveLockState (persistent locked flag vs ephemeral session)", () => {
  beforeEach(async () => {
    await saveEncryptedWallet(
      { encrypted: "00", nonce: "00", salt: "00" },
      "paraloom1" + "11".repeat(64) + "deadbeef"
    )
  })

  it("treats wallet as locked and repairs local storage when locked=false but session is missing", async () => {
    // Simulates browser restart after an unlocked session: chrome.storage.local
    // retains `locked: false`, while memory-only chrome.storage.session is empty.
    await setLockState(false)
    await clearSession()
    expect(await isWalletLocked()).toBe(false)

    const effectivelyLocked = await reconcileEffectiveLockState()
    expect(effectivelyLocked).toBe(true)
    expect(await isWalletLocked()).toBe(true)
  })

  it("returns false (unlocked) only when both local lock state is false and a session exists", async () => {
    await saveSession(dummySession())
    await setLockState(false)

    expect(await reconcileEffectiveLockState()).toBe(false)
    expect(await isWalletLocked()).toBe(false)
  })

  it("returns true (locked) when local lock state is true even if a stale session exists", async () => {
    await saveSession(dummySession())
    await setLockState(true)

    expect(await reconcileEffectiveLockState()).toBe(true)
  })
})
