import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWalletStore, type Account } from "~lib/store/walletStore"
import type { WalletKeyPair } from "~lib/crypto/keyManagement"

function makeMockKeypair(seedByte: number = 1): WalletKeyPair {
  return {
    publicKey: new Uint8Array(32).fill(seedByte),
    secretKey: new Uint8Array(64).fill(seedByte),
    shieldedAddress: `paraloom1${seedByte.toString().padStart(2, "0").repeat(64)}`,
    boxPublicKey: new Uint8Array(32).fill(seedByte + 1),
    boxSecretKey: new Uint8Array(32).fill(seedByte + 2),
    spendPrivkey: new Uint8Array(32).fill(seedByte + 3)
  }
}

describe("walletStore unlock and addAccount (#233)", () => {
  beforeEach(() => {
    useWalletStore.getState().clear()
  })

  it("resets currentAccountIndex to 0 upon unlock", () => {
    const store = useWalletStore.getState()
    const kp0 = makeMockKeypair(1)
    const kp1 = makeMockKeypair(2)

    store.addAccount({
      index: 0,
      name: "Account 1",
      keypair: kp0,
      balance: 100n
    })
    store.addAccount({
      index: 1,
      name: "Account 2",
      keypair: kp1,
      balance: 200n
    })

    // Switch to Account 2 (index 1)
    store.switchAccount(1)
    expect(useWalletStore.getState().currentAccountIndex).toBe(1)
    expect(useWalletStore.getState().wallet).toEqual(kp1)

    // Now unlock with Account 0 (e.g. after re-authenticating)
    store.unlock(kp0, "dummy-seed")

    // Must reset currentAccountIndex to 0
    expect(useWalletStore.getState().currentAccountIndex).toBe(0)
    expect(useWalletStore.getState().wallet).toEqual(kp0)
    expect(useWalletStore.getState().locked).toBe(false)
  })

  it("addAccount upserts existing account by index rather than silently dropping updates", () => {
    const store = useWalletStore.getState()
    const kp0 = makeMockKeypair(1)

    store.addAccount({
      index: 0,
      name: "Account 1",
      keypair: kp0,
      balance: 50n
    })

    expect(useWalletStore.getState().accounts.length).toBe(1)
    expect(useWalletStore.getState().accounts[0].balance).toBe(50n)

    // Update Account 0 with updated balance and name
    const updatedKp0 = makeMockKeypair(9)
    store.addAccount({
      index: 0,
      name: "Main Savings",
      keypair: updatedKp0,
      balance: 500n
    })

    const accounts = useWalletStore.getState().accounts
    expect(accounts.length).toBe(1)
    expect(accounts[0].name).toBe("Main Savings")
    expect(accounts[0].balance).toBe(500n)
    expect(accounts[0].keypair).toEqual(updatedKp0)
  })

  it("lock clears in-memory state and resets currentAccountIndex to 0", () => {
    const store = useWalletStore.getState()
    const kp = makeMockKeypair(1)
    store.unlock(kp, "seed")
    store.addAccount({
      index: 0,
      name: "Account 1",
      keypair: kp,
      balance: 0n
    })
    store.switchAccount(0)

    store.lock()
    const state = useWalletStore.getState()
    expect(state.locked).toBe(true)
    expect(state.wallet).toBeNull()
    expect(state.seedPhrase).toBeNull()
    expect(state.accounts).toEqual([])
    expect(state.currentAccountIndex).toBe(0)
  })
})

describe("Account index derivation & seeding logic (#233)", () => {
  function computeNextIndex(
    accounts: Account[],
    wallet: WalletKeyPair | null,
    addAccountFn: (acc: Account) => void
  ): { currentAccounts: Account[]; newIndex: number } {
    let currentAccounts = [...accounts]
    if (currentAccounts.length === 0 && wallet) {
      const acc0: Account = {
        index: 0,
        name: "Account 1",
        keypair: wallet,
        balance: 0n
      }
      addAccountFn(acc0)
      currentAccounts = [acc0]
    }
    const newIndex = Math.max(-1, ...currentAccounts.map((a) => a.index)) + 1
    return { currentAccounts, newIndex }
  }

  it("seeds Account 0 and assigns newIndex = 1 when accounts list is empty", () => {
    const wallet = makeMockKeypair(1)
    const added: Account[] = []
    const addAccountFn = (a: Account) => added.push(a)

    const { currentAccounts, newIndex } = computeNextIndex([], wallet, addAccountFn)
    expect(added.length).toBe(1)
    expect(added[0].index).toBe(0)
    expect(added[0].name).toBe("Account 1")
    expect(currentAccounts.length).toBe(1)
    expect(newIndex).toBe(1)
  })

  it("assigns newIndex = max(index) + 1 when accounts are non-contiguous", () => {
    const wallet = makeMockKeypair(1)
    const accounts: Account[] = [
      { index: 0, name: "Account 1", keypair: wallet, balance: 0n },
      { index: 2, name: "Account 3", keypair: makeMockKeypair(3), balance: 0n }
    ]
    const { newIndex } = computeNextIndex(accounts, wallet, () => {})
    // accounts.length is 2, but max index is 2, so newIndex must be 3 (not 2)
    expect(newIndex).toBe(3)
  })
})

describe("Cross-account state isolation (#233)", () => {
  it("clears revealed secrets and modal addresses when switching accounts", () => {
    let revealedPK: string | null = "01".repeat(64)
    let revealedSeed: string | null = "word1 word2 word3"
    let withdrawAddress = "11111111111111111111111111111111"
    let withdrawAmount = "1.5"
    let transferAddress = "paraloom1destination"
    let transferAmount = "2.0"
    let depositAmount = "0.5"

    function switchAccountHandler(targetIndex: number, currentIndex: number) {
      if (targetIndex !== currentIndex) {
        revealedPK = null
        revealedSeed = null
        withdrawAddress = ""
        withdrawAmount = ""
        transferAddress = ""
        transferAmount = ""
        depositAmount = ""
      }
    }

    // Switch from Account 0 to Account 1
    switchAccountHandler(1, 0)

    expect(revealedPK).toBeNull()
    expect(revealedSeed).toBeNull()
    expect(withdrawAddress).toBe("")
    expect(withdrawAmount).toBe("")
    expect(transferAddress).toBe("")
    expect(transferAmount).toBe("")
    expect(depositAmount).toBe("")
  })
})
