import { beforeEach, describe, expect, it, vi } from "vitest"
import { deriveKeypairFromSeed, generateSeedPhrase } from "../lib/crypto/keyManagement"
import { getStoredWallet, saveEncryptedWallet, updateAccounts } from "../lib/storage/secure"
import { loadSession, saveSession } from "../lib/storage/session"
import { useWalletStore, type Account } from "../lib/store/walletStore"
import { installFakeChrome } from "./support/chromeStorage"

const { v3NotePubkey } = vi.hoisted(() => ({
  v3NotePubkey: vi.fn(async (privkeyHex: string) => `01${privkeyHex.slice(2)}`)
}))

vi.mock("~lib/prover", () => ({
  v3NotePubkey,
  NATIVE_ASSET_HEX: "00".repeat(32)
}))

describe("accountManagement", () => {
  beforeEach(() => {
    installFakeChrome()
    useWalletStore.getState().clear()
  })

  describe("walletStore.unlock", () => {
    it("resets currentAccountIndex to 0 by default, clearing any stale index", async () => {
      const seed = generateSeedPhrase()
      const kp0 = await deriveKeypairFromSeed(seed, 0)
      const kp1 = await deriveKeypairFromSeed(seed, 1)

      const store = useWalletStore.getState()
      store.addAccount({ index: 0, name: "Account 1", keypair: kp0, balance: 0n })
      store.addAccount({ index: 1, name: "Account 2", keypair: kp1, balance: 0n })
      store.switchAccount(1)

      expect(useWalletStore.getState().currentAccountIndex).toBe(1)

      // Unlock without currentAccountIndex argument must reset currentAccountIndex to 0
      useWalletStore.getState().unlock(kp0, seed)
      expect(useWalletStore.getState().currentAccountIndex).toBe(0)
      expect(useWalletStore.getState().locked).toBe(false)
    })

    it("respects provided currentAccountIndex when restoring session", async () => {
      const seed = generateSeedPhrase()
      const kp0 = await deriveKeypairFromSeed(seed, 0)
      const kp1 = await deriveKeypairFromSeed(seed, 1)

      const store = useWalletStore.getState()
      store.unlock(kp1, seed, 1)

      expect(useWalletStore.getState().currentAccountIndex).toBe(1)
      expect(useWalletStore.getState().wallet).toBe(kp1)
    })
  })

  describe("empty stored.accounts fallback and account creation", () => {
    it("initializes Account 0 when stored.accounts is empty and prevents index collision on create", async () => {
      const seed = generateSeedPhrase()
      const rootWallet = await deriveKeypairFromSeed(seed, 0)

      // Simulate a stored wallet with empty accounts array
      await saveEncryptedWallet(
        { encrypted: "data", nonce: "nonce", salt: "salt" },
        rootWallet.shieldedAddress,
        seed,
        "password",
        []
      )

      const stored = await getStoredWallet()
      expect(stored).not.toBeNull()
      expect(stored?.accounts).toBeUndefined() // empty accounts array omitted by saveEncryptedWallet

      // Emulate Unlock logic when stored.accounts is empty
      const store = useWalletStore.getState()
      const currentStoreAccounts = store.accounts
      if (currentStoreAccounts.length === 0) {
        const defaultAccount: Account = {
          index: 0,
          name: "Account 1",
          keypair: rootWallet,
          balance: 0n
        }
        store.addAccount(defaultAccount)
        await updateAccounts([defaultAccount])
      }
      store.unlock(rootWallet, seed, 0)

      // Verify Account 0 exists in store and storage
      expect(useWalletStore.getState().accounts.length).toBe(1)
      expect(useWalletStore.getState().accounts[0].index).toBe(0)
      expect(useWalletStore.getState().accounts[0].name).toBe("Account 1")

      const storedAfterUnlock = await getStoredWallet()
      expect(storedAfterUnlock?.accounts?.length).toBe(1)
      expect(storedAfterUnlock?.accounts?.[0].index).toBe(0)

      // Now create a new account (as handleCreateAccount does)
      const accounts = useWalletStore.getState().accounts
      const maxIndex = accounts.reduce((max, a) => Math.max(max, a.index), -1)
      const newIndex = maxIndex + 1
      expect(newIndex).toBe(1) // must be 1, NOT 0!

      const kp1 = await deriveKeypairFromSeed(seed, newIndex)
      const newAccount: Account = {
        index: newIndex,
        name: `Account ${newIndex + 1}`,
        keypair: kp1,
        balance: 0n
      }
      store.addAccount(newAccount)
      await updateAccounts([...accounts, newAccount])
      store.switchAccount(newIndex)

      expect(useWalletStore.getState().accounts.length).toBe(2)
      expect(useWalletStore.getState().accounts[0].index).toBe(0)
      expect(useWalletStore.getState().accounts[1].index).toBe(1)
      expect(useWalletStore.getState().currentAccountIndex).toBe(1)
    })

    it("handleCreateAccount self-heals empty store accounts by establishing Account 0 first", async () => {
      const seed = generateSeedPhrase()
      const rootWallet = await deriveKeypairFromSeed(seed, 0)

      useWalletStore.getState().unlock(rootWallet, seed, 0)
      expect(useWalletStore.getState().accounts.length).toBe(0)

      const state = useWalletStore.getState()
      // Execute handleCreateAccount fallback logic
      let currentAccounts = [...state.accounts]
      if (currentAccounts.length === 0 && state.wallet) {
        const baseAccount: Account = {
          index: 0,
          name: "Account 1",
          keypair: state.wallet,
          balance: 0n
        }
        state.addAccount(baseAccount)
        currentAccounts = [baseAccount]
      }

      const maxIndex = currentAccounts.reduce((max, a) => Math.max(max, a.index), -1)
      const newIndex = maxIndex + 1
      expect(newIndex).toBe(1)

      const kp1 = await deriveKeypairFromSeed(seed, newIndex)
      const newAccount: Account = {
        index: newIndex,
        name: `Account ${newIndex + 1}`,
        keypair: kp1,
        balance: 0n
      }
      state.addAccount(newAccount)
      await updateAccounts([...currentAccounts, newAccount])
      state.switchAccount(newIndex)

      const finalState = useWalletStore.getState()
      expect(finalState.accounts.length).toBe(2)
      expect(finalState.accounts[0].index).toBe(0)
      expect(finalState.accounts[0].name).toBe("Account 1")
      expect(finalState.accounts[1].index).toBe(1)
      expect(finalState.accounts[1].name).toBe("Account 2")
      expect(finalState.currentAccountIndex).toBe(1)
    })
  })

  describe("account switching isolation", () => {
    it("switches accounts and isolates active wallet and balance", async () => {
      const seed = generateSeedPhrase()
      const kp0 = await deriveKeypairFromSeed(seed, 0)
      const kp1 = await deriveKeypairFromSeed(seed, 1)

      const store = useWalletStore.getState()
      store.unlock(kp0, seed, 0)
      store.addAccount({ index: 0, name: "Account 1", keypair: kp0, balance: 100n })
      store.addAccount({ index: 1, name: "Account 2", keypair: kp1, balance: 250n })

      store.switchAccount(0)
      expect(useWalletStore.getState().currentAccountIndex).toBe(0)
      expect(useWalletStore.getState().balance).toBe(100n)
      expect(useWalletStore.getState().wallet?.shieldedAddress).toBe(kp0.shieldedAddress)

      store.switchAccount(1)
      expect(useWalletStore.getState().currentAccountIndex).toBe(1)
      expect(useWalletStore.getState().balance).toBe(250n)
      expect(useWalletStore.getState().wallet?.shieldedAddress).toBe(kp1.shieldedAddress)
    })

    it("ensures session is kept in sync on account switch", async () => {
      const seed = generateSeedPhrase()
      const kp0 = await deriveKeypairFromSeed(seed, 0)
      const kp1 = await deriveKeypairFromSeed(seed, 1)

      const store = useWalletStore.getState()
      store.unlock(kp0, seed, 0)
      const acc0: Account = { index: 0, name: "Account 1", keypair: kp0, balance: 100n }
      const acc1: Account = { index: 1, name: "Account 2", keypair: kp1, balance: 250n }
      store.addAccount(acc0)
      store.addAccount(acc1)

      store.switchAccount(1)
      const st = useWalletStore.getState()
      await saveSession({
        wallet: st.wallet!,
        accounts: st.accounts,
        currentAccountIndex: st.currentAccountIndex,
        seedPhrase: st.seedPhrase
      })

      const session = await loadSession()
      expect(session?.currentAccountIndex).toBe(1)
      expect(session?.wallet.shieldedAddress).toBe(kp1.shieldedAddress)
    })
  })
})
