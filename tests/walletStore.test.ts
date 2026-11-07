import { beforeEach, describe, expect, it } from "vitest"
import type { WalletKeyPair } from "~lib/crypto/keyManagement"
import { useWalletStore } from "~lib/store/walletStore"

function makeKeyPair(fill: number): WalletKeyPair {
  return {
    publicKey: new Uint8Array(32).fill(fill),
    secretKey: new Uint8Array(64).fill(fill),
    shieldedAddress: `paraloom1${fill.toString(16).padStart(2, "0").repeat(68)}`,
    boxPublicKey: new Uint8Array(32).fill(fill),
    boxSecretKey: new Uint8Array(32).fill(fill),
    spendPrivkey: new Uint8Array(32).fill(fill)
  }
}

describe("walletStore multi-account invariants (#233)", () => {
  beforeEach(() => {
    useWalletStore.getState().clear()
  })

  it("resets currentAccountIndex to 0 on unlock so wallet and index never diverge", () => {
    const kp0 = makeKeyPair(0x01)
    const kp1 = makeKeyPair(0x02)
    const store = useWalletStore.getState()

    store.addAccount({ index: 0, name: "Account 1", keypair: kp0, balance: 0n })
    store.addAccount({ index: 1, name: "Account 2", keypair: kp1, balance: 0n })
    store.switchAccount(1)
    expect(useWalletStore.getState().currentAccountIndex).toBe(1)

    // Re-unlocking with Account 0 must reset currentAccountIndex to 0.
    useWalletStore.getState().unlock(kp0, "test seed")
    expect(useWalletStore.getState().currentAccountIndex).toBe(0)
    expect(useWalletStore.getState().wallet).toEqual(kp0)
  })

  it("upserts existing account indices in addAccount when re-hydrating", () => {
    const kp0 = makeKeyPair(0x01)
    const kp0Updated = makeKeyPair(0x03)
    const store = useWalletStore.getState()

    store.addAccount({ index: 0, name: "Account 1", keypair: kp0, balance: 10n })
    store.addAccount({ index: 0, name: "Renamed", keypair: kp0Updated, balance: 50n })

    const accounts = useWalletStore.getState().accounts
    expect(accounts).toHaveLength(1)
    expect(accounts[0].name).toBe("Renamed")
    expect(accounts[0].balance).toBe(50n)
    expect(accounts[0].keypair).toEqual(kp0Updated)
  })
})
