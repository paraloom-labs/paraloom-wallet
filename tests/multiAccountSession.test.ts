import { beforeEach, describe, expect, it } from "vitest"
import { deriveKeypairFromSeed, encryptWallet, generateSeedPhrase } from "~lib/crypto/keyManagement"
import {
  getStoredWallet,
  saveEncryptedWallet,
  setActiveAccount,
  setLockState,
  updateAccounts
} from "~lib/storage/secure"
import { loadSession, saveSession } from "~lib/storage/session"
import { useWalletStore, type Account } from "~lib/store/walletStore"
import { installFakeChrome } from "./support/chromeStorage"

beforeEach(() => {
  installFakeChrome()
  useWalletStore.getState().clear()
})

describe("multi-account session and active-account persistence", () => {
  it("persists session on onboarding and synchronizes session + stored address across account creation, switch, and popup re-init", async () => {
    const seed = generateSeedPhrase()
    const kp0 = await deriveKeypairFromSeed(seed, 0)
    const kp1 = await deriveKeypairFromSeed(seed, 1)

    const account0: Account = {
      index: 0,
      name: "Account 1",
      keypair: kp0,
      balance: 0n
    }
    const account1: Account = {
      index: 1,
      name: "Account 2",
      keypair: kp1,
      balance: 0n
    }

    // 1. Onboarding flow: saves encrypted wallet, unlocks, and persists session
    const encrypted = encryptWallet(kp0, "password123")
    await saveEncryptedWallet(encrypted, kp0.shieldedAddress, seed, "password123", [account0])
    await setLockState(false)
    await saveSession({
      wallet: kp0,
      accounts: [account0],
      currentAccountIndex: 0,
      seedPhrase: seed
    })

    const initialSession = await loadSession()
    expect(initialSession).not.toBeNull()
    expect(initialSession!.wallet.shieldedAddress).toBe(kp0.shieldedAddress)
    expect(initialSession!.currentAccountIndex).toBe(0)

    const initialStored = await getStoredWallet()
    expect(initialStored!.address).toBe(kp0.shieldedAddress)
    expect(initialStored!.currentAccountIndex).toBe(0)

    // 2. Create Account 2 and switch to it (Home.tsx handleCreateAccount)
    const updatedAccounts = [account0, account1]
    await updateAccounts(updatedAccounts, 1)
    await saveSession({
      wallet: account1.keypair,
      accounts: updatedAccounts,
      currentAccountIndex: 1,
      seedPhrase: seed
    })

    // Background worker reads active account from loadSession() and getStoredWallet()
    const sessionAfterCreate = await loadSession()
    expect(sessionAfterCreate!.wallet.shieldedAddress).toBe(kp1.shieldedAddress)
    expect(sessionAfterCreate!.currentAccountIndex).toBe(1)
    expect(sessionAfterCreate!.accounts).toHaveLength(2)

    const storedAfterCreate = await getStoredWallet()
    expect(storedAfterCreate!.address).toBe(kp1.shieldedAddress)
    expect(storedAfterCreate!.currentAccountIndex).toBe(1)

    // 3. Reopening popup (popup/index.tsx initWallet) restores Account 2, not Account 1
    useWalletStore.getState().clear()
    const restoredSession = await loadSession()
    const store = useWalletStore.getState()
    store.unlock(restoredSession!.wallet, restoredSession!.seedPhrase ?? undefined)
    restoredSession!.accounts.forEach((a) => store.addAccount(a))
    if (typeof restoredSession!.currentAccountIndex === "number") {
      store.switchAccount(restoredSession!.currentAccountIndex)
    }

    expect(useWalletStore.getState().currentAccountIndex).toBe(1)
    expect(useWalletStore.getState().wallet?.shieldedAddress).toBe(kp1.shieldedAddress)
    expect(useWalletStore.getState().accounts).toHaveLength(2)

    // 4. Switch back to Account 1 (Home.tsx handleSwitchAccount)
    useWalletStore.getState().switchAccount(0)
    await setActiveAccount(0, account0.keypair.shieldedAddress)
    await saveSession({
      wallet: account0.keypair,
      accounts: updatedAccounts,
      currentAccountIndex: 0,
      seedPhrase: seed
    })

    const sessionAfterSwitch = await loadSession()
    expect(sessionAfterSwitch!.wallet.shieldedAddress).toBe(kp0.shieldedAddress)
    expect(sessionAfterSwitch!.currentAccountIndex).toBe(0)

    const storedAfterSwitch = await getStoredWallet()
    expect(storedAfterSwitch!.address).toBe(kp0.shieldedAddress)
    expect(storedAfterSwitch!.currentAccountIndex).toBe(0)
  })
})
