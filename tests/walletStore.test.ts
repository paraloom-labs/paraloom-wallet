import { beforeEach, describe, expect, it } from "vitest"
import { useWalletStore, type Account } from "../lib/store/walletStore"
import type { WalletKeyPair } from "../lib/crypto/keyManagement"

function makeKeypair(id: number): WalletKeyPair {
  return {
    publicKey: new Uint8Array(32).fill(id),
    secretKey: new Uint8Array(64).fill(id),
    spendPrivkey: new Uint8Array(32).fill(id),
    boxSecretKey: new Uint8Array(32).fill(id),
    boxPublicKey: new Uint8Array(32).fill(id),
    shieldedAddress: `paraloom1${id.toString().padStart(64, "0")}`
  }
}

function makeAccount(index: number, balance = 0n): Account {
  return {
    index,
    name: `Account ${index + 1}`,
    keypair: makeKeypair(index + 1),
    balance
  }
}

describe("walletStore balance sync & account upsert (#257)", () => {
  beforeEach(() => {
    useWalletStore.getState().clear()
  })

  it("updates active account balance in accounts array on setBalance (#257)", () => {
    const store = useWalletStore.getState()
    const acc0 = makeAccount(0, 0n)
    const acc1 = makeAccount(1, 0n)
    store.addAccount(acc0)
    store.addAccount(acc1)

    // Current account is 0
    expect(useWalletStore.getState().currentAccountIndex).toBe(0)

    // Set balance for account 0
    store.setBalance(5_000_000n)

    const state = useWalletStore.getState()
    expect(state.balance).toBe(5_000_000n)
    expect(state.accounts[0].balance).toBe(5_000_000n)
    expect(state.accounts[1].balance).toBe(0n)

    // Switch to account 1
    state.switchAccount(1)
    expect(useWalletStore.getState().currentAccountIndex).toBe(1)
    expect(useWalletStore.getState().balance).toBe(0n)

    // Set balance for account 1
    useWalletStore.getState().setBalance(10_000_000n)
    expect(useWalletStore.getState().balance).toBe(10_000_000n)
    expect(useWalletStore.getState().accounts[1].balance).toBe(10_000_000n)

    // Switch back to account 0 - must restore 5_000_000n without getting overwritten with 0n
    useWalletStore.getState().switchAccount(0)
    expect(useWalletStore.getState().currentAccountIndex).toBe(0)
    expect(useWalletStore.getState().balance).toBe(5_000_000n)
  })

  it("upserts existing accounts by index on addAccount (#257)", () => {
    const store = useWalletStore.getState()
    const acc0 = makeAccount(0, 100n)
    store.addAccount(acc0)

    expect(useWalletStore.getState().accounts).toHaveLength(1)
    expect(useWalletStore.getState().accounts[0].name).toBe("Account 1")
    expect(useWalletStore.getState().accounts[0].balance).toBe(100n)

    // Re-add account 0 with updated name and balance
    const updatedAcc0: Account = {
      ...acc0,
      name: "Main Savings",
      balance: 999n
    }
    useWalletStore.getState().addAccount(updatedAcc0)

    const accounts = useWalletStore.getState().accounts
    expect(accounts).toHaveLength(1)
    expect(accounts[0].name).toBe("Main Savings")
    expect(accounts[0].balance).toBe(999n)

    // Active account balance and wallet should sync when the active account is updated
    expect(useWalletStore.getState().balance).toBe(999n)
  })

  it("adds distinct accounts without collision", () => {
    const store = useWalletStore.getState()
    store.addAccount(makeAccount(0, 10n))
    store.addAccount(makeAccount(1, 20n))
    store.addAccount(makeAccount(2, 30n))

    const accounts = useWalletStore.getState().accounts
    expect(accounts).toHaveLength(3)
    expect(accounts.map((a) => a.index)).toEqual([0, 1, 2])
  })
})
