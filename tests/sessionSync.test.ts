import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  v3NotePubkey: async () => "00".repeat(32)
}))

import {
  getStoredWallet,
  saveEncryptedWallet,
  setActiveAccountAddress,
  updateAccounts
} from "~lib/storage/secure"
import { loadSession, saveSession } from "~lib/storage/session"
import type { EncryptedWallet, WalletKeyPair } from "~lib/crypto/keyManagement"
import type { Account } from "~lib/store/walletStore"
import { installFakeChrome } from "./support/chromeStorage"

function makeKeypair(tag: number): WalletKeyPair {
  const byte = (n: number) => new Uint8Array(n).fill(tag)
  return {
    publicKey: byte(32),
    secretKey: byte(64),
    boxPublicKey: byte(32),
    boxSecretKey: byte(32),
    spendPrivkey: byte(32),
    shieldedAddress: `paraloom1_${tag}_${"00".repeat(30)}`
  }
}

const DUMMY_ENCRYPTED: EncryptedWallet = {
  encrypted: "aa",
  nonce: "bb",
  salt: "cc"
}

beforeEach(() => {
  installFakeChrome()
})

describe("multi-account session and StoredWallet.address synchronization", () => {
  it("updates StoredWallet.address when switching active accounts via setActiveAccountAddress", async () => {
    const kp0 = makeKeypair(1)
    const kp1 = makeKeypair(2)
    const acc0: Account = { index: 0, name: "Account 1", keypair: kp0, balance: 0n }
    const acc1: Account = { index: 1, name: "Account 2", keypair: kp1, balance: 500n }

    await saveEncryptedWallet(DUMMY_ENCRYPTED, kp0.shieldedAddress, undefined, undefined, [acc0])
    expect((await getStoredWallet())?.address).toBe(kp0.shieldedAddress)

    await updateAccounts([acc0, acc1])
    await setActiveAccountAddress(kp1.shieldedAddress)

    const stored = await getStoredWallet()
    expect(stored?.address).toBe(kp1.shieldedAddress)
    expect(stored?.accounts).toHaveLength(2)
  })

  it("persists and restores the switched account keypair and index in chrome.storage.session", async () => {
    const kp0 = makeKeypair(1)
    const kp1 = makeKeypair(2)
    const acc0: Account = { index: 0, name: "Account 1", keypair: kp0, balance: 100n }
    const acc1: Account = { index: 1, name: "Account 2", keypair: kp1, balance: 250n }

    // Initial onboarding session (Account 1)
    await saveSession({
      wallet: kp0,
      accounts: [acc0],
      currentAccountIndex: 0,
      seedPhrase: "test seed"
    })
    let loaded = await loadSession()
    expect(loaded?.wallet.shieldedAddress).toBe(kp0.shieldedAddress)
    expect(loaded?.currentAccountIndex).toBe(0)

    // Switch to Account 2
    await saveSession({
      wallet: kp1,
      accounts: [acc0, acc1],
      currentAccountIndex: 1,
      seedPhrase: "test seed"
    })
    loaded = await loadSession()
    expect(loaded?.wallet.shieldedAddress).toBe(kp1.shieldedAddress)
    expect(loaded?.currentAccountIndex).toBe(1)
    expect(loaded?.accounts).toHaveLength(2)
    expect(loaded?.accounts[1].balance).toBe(250n)
  })
})
