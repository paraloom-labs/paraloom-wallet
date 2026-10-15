import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  v3NotePubkey: vi.fn(async (hex: string) => hex)
}))

import type { WalletKeyPair } from "~lib/crypto/keyManagement"
import { getStoredWallet, saveEncryptedWallet, updateAccounts } from "~lib/storage/secure"
import { loadSession, saveSession, updateSessionAccount } from "~lib/storage/session"
import { useWalletStore, type Account } from "~lib/store/walletStore"
import { installFakeChrome } from "./support/chromeStorage"

function makeKeypair(tag: number): WalletKeyPair {
  const b = (fill: number) => new Uint8Array(32).fill(fill)
  const hex = Buffer.from(b(tag)).toString("hex")
  return {
    publicKey: b(tag),
    secretKey: new Uint8Array(64).fill(tag),
    shieldedAddress: `paraloom1${hex}${hex}00000000`,
    boxPublicKey: b(tag + 1),
    boxSecretKey: b(tag + 2),
    spendPrivkey: b(tag + 3)
  }
}

beforeEach(() => {
  installFakeChrome()
  useWalletStore.getState().clear()
})

describe("multi-account session & storage synchronization", () => {
  it("updates session.wallet and currentAccountIndex when switching to a secondary account", async () => {
    const kp0 = makeKeypair(0x11)
    const kp1 = makeKeypair(0x22)
    const acc0: Account = { index: 0, name: "Account 1", keypair: kp0, balance: 0n }
    const acc1: Account = { index: 1, name: "Account 2", keypair: kp1, balance: 0n }

    await saveSession({
      wallet: kp0,
      accounts: [acc0, acc1],
      currentAccountIndex: 0,
      seedPhrase: "test seed phrase"
    })

    // Switch to Account 2 (index 1)
    await updateSessionAccount(1)

    const loaded = await loadSession()
    expect(loaded).not.toBeNull()
    expect(loaded!.currentAccountIndex).toBe(1)
    expect(loaded!.wallet.shieldedAddress).toBe(kp1.shieldedAddress)
    expect(Buffer.from(loaded!.wallet.spendPrivkey).toString("hex")).toBe(
      Buffer.from(kp1.spendPrivkey).toString("hex")
    )
  })

  it("persists newly created account in session and switches active wallet to it", async () => {
    const kp0 = makeKeypair(0x11)
    const kp1 = makeKeypair(0x22)
    const acc0: Account = { index: 0, name: "Account 1", keypair: kp0, balance: 0n }
    const acc1: Account = { index: 1, name: "Account 2", keypair: kp1, balance: 0n }

    await saveSession({
      wallet: kp0,
      accounts: [acc0],
      currentAccountIndex: 0,
      seedPhrase: "test seed phrase"
    })

    // Create Account 2 and switch to it
    await updateSessionAccount(1, [acc0, acc1])

    const loaded = await loadSession()
    expect(loaded!.accounts).toHaveLength(2)
    expect(loaded!.currentAccountIndex).toBe(1)
    expect(loaded!.wallet.shieldedAddress).toBe(kp1.shieldedAddress)
  })

  it("updates StoredWallet.address when switching active account so GET_ADDRESS matches", async () => {
    const kp0 = makeKeypair(0x11)
    const kp1 = makeKeypair(0x22)
    const acc0: Account = { index: 0, name: "Account 1", keypair: kp0, balance: 0n }
    const acc1: Account = { index: 1, name: "Account 2", keypair: kp1, balance: 0n }

    await saveEncryptedWallet(
      { encrypted: "aa", nonce: "bb", salt: "cc" },
      kp0.shieldedAddress,
      undefined,
      undefined,
      [acc0]
    )

    await updateAccounts([acc0, acc1], 1)

    const stored = await getStoredWallet()
    expect(stored?.address).toBe(kp1.shieldedAddress)
  })
})
