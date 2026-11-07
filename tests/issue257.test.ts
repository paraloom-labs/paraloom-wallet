import { useWalletStore, type Account } from "~lib/store/walletStore"
import { isValidPendingSwap, Popup, type PendingSwap } from "~src/popup/index"
import { SwapApprove } from "~src/popup/SwapApprove"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { installFakeChrome } from "./support/chromeStorage"

vi.mock("~lib/prover", () => ({
  v3NotePubkey: vi.fn().mockResolvedValue("mock-pubkey"),
  NATIVE_ASSET_HEX: "00".repeat(32)
}))

const mockKeypair = {
  publicKey: new Uint8Array(32).fill(1),
  secretKey: new Uint8Array(64).fill(2),
  shieldedAddress: "paraloom1testaddress123",
  boxPublicKey: new Uint8Array(32).fill(3),
  boxSecretKey: new Uint8Array(32).fill(4),
  spendPrivkey: new Uint8Array(32).fill(5)
}

const mockKeypair2 = {
  publicKey: new Uint8Array(32).fill(6),
  secretKey: new Uint8Array(64).fill(7),
  shieldedAddress: "paraloom1testaddress456",
  boxPublicKey: new Uint8Array(32).fill(8),
  boxSecretKey: new Uint8Array(32).fill(9),
  spendPrivkey: new Uint8Array(32).fill(10)
}

beforeEach(() => {
  installFakeChrome()
  useWalletStore.getState().clear()
  vi.clearAllMocks()
})

describe("walletStore account balance updates (#257)", () => {
  it("updates the active account balance in accounts array when setBalance is called", () => {
    const store = useWalletStore.getState()
    const account0: Account = {
      index: 0,
      name: "Account 0",
      keypair: mockKeypair,
      balance: 1000n
    }
    const account1: Account = {
      index: 1,
      name: "Account 1",
      keypair: mockKeypair2,
      balance: 2000n
    }

    store.addAccount(account0)
    store.addAccount(account1)
    store.switchAccount(0)

    expect(useWalletStore.getState().balance).toBe(1000n)
    expect(useWalletStore.getState().accounts[0].balance).toBe(1000n)

    // Update balance
    useWalletStore.getState().setBalance(5500n)

    // Active balance in state and Account 0 in accounts array must both be 5500n
    expect(useWalletStore.getState().balance).toBe(5500n)
    expect(useWalletStore.getState().accounts[0].balance).toBe(5500n)
    expect(useWalletStore.getState().accounts[1].balance).toBe(2000n)

    // Switch to Account 1 and then back to Account 0
    useWalletStore.getState().switchAccount(1)
    expect(useWalletStore.getState().balance).toBe(2000n)

    useWalletStore.getState().switchAccount(0)
    // The balance update on Account 0 must NOT have been dropped
    expect(useWalletStore.getState().balance).toBe(5500n)
  })

  it("updates existing account when addAccount is called with updated balance", () => {
    const store = useWalletStore.getState()
    const account0: Account = {
      index: 0,
      name: "Account 0",
      keypair: mockKeypair,
      balance: 1000n
    }
    store.addAccount(account0)
    store.switchAccount(0)

    // addAccount called with updated balance for account 0
    store.addAccount({ ...account0, balance: 9999n })

    expect(useWalletStore.getState().accounts).toHaveLength(1)
    expect(useWalletStore.getState().accounts[0].balance).toBe(9999n)
    expect(useWalletStore.getState().balance).toBe(9999n)
  })
})

describe("Account 0 restoration on falsy currentAccountIndex (#257)", () => {
  it("restores Account 0 when session.currentAccountIndex is 0", async () => {
    const store = useWalletStore.getState()
    const session = {
      wallet: mockKeypair,
      accounts: [
        { index: 0, name: "Account 0", keypair: mockKeypair, balance: 4200n },
        { index: 1, name: "Account 1", keypair: mockKeypair2, balance: 8400n }
      ],
      currentAccountIndex: 0,
      seedPhrase: null
    }

    store.unlock(session.wallet, session.seedPhrase ?? undefined)
    session.accounts.forEach((a) => store.addAccount(a))

    // Bug in index.tsx was `if (session.currentAccountIndex)` which skipped 0
    if (typeof session.currentAccountIndex === "number") {
      store.switchAccount(session.currentAccountIndex)
    }

    const state = useWalletStore.getState()
    expect(state.currentAccountIndex).toBe(0)
    expect(state.balance).toBe(4200n)
    expect(state.wallet?.shieldedAddress).toBe(mockKeypair.shieldedAddress)
  })

  it("restores Account 1 when session.currentAccountIndex is 1", async () => {
    const store = useWalletStore.getState()
    const session = {
      wallet: mockKeypair,
      accounts: [
        { index: 0, name: "Account 0", keypair: mockKeypair, balance: 4200n },
        { index: 1, name: "Account 1", keypair: mockKeypair2, balance: 8400n }
      ],
      currentAccountIndex: 1,
      seedPhrase: null
    }

    store.unlock(session.wallet, session.seedPhrase ?? undefined)
    session.accounts.forEach((a) => store.addAccount(a))

    if (typeof session.currentAccountIndex === "number") {
      store.switchAccount(session.currentAccountIndex)
    }

    const state = useWalletStore.getState()
    expect(state.currentAccountIndex).toBe(1)
    expect(state.balance).toBe(8400n)
    expect(state.wallet?.shieldedAddress).toBe(mockKeypair2.shieldedAddress)
  })
})

describe("isValidPendingSwap validation (#257)", () => {
  const validSwap: PendingSwap = {
    id: 123,
    origin: "https://dapp.paraloom.io",
    params: {
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inputMint: "SOL",
      amountLamports: "1000000",
      slippageBps: 50,
      reshield: true
    }
  }

  it("accepts valid PendingSwap", () => {
    expect(isValidPendingSwap(validSwap)).toBe(true)
    expect(
      isValidPendingSwap({
        ...validSwap,
        params: { ...validSwap.params, inputMint: undefined }
      })
    ).toBe(true)
    expect(
      isValidPendingSwap({
        ...validSwap,
        params: { ...validSwap.params, slippageBps: undefined }
      })
    ).toBe(true)
    expect(
      isValidPendingSwap({
        ...validSwap,
        params: { ...validSwap.params, reshield: undefined }
      })
    ).toBe(true)
  })

  it("rejects non-object, null, or undefined", () => {
    expect(isValidPendingSwap(null)).toBe(false)
    expect(isValidPendingSwap(undefined)).toBe(false)
    expect(isValidPendingSwap("swap")).toBe(false)
    expect(isValidPendingSwap(123)).toBe(false)
  })

  it("rejects invalid id or origin", () => {
    expect(isValidPendingSwap({ ...validSwap, id: "123" })).toBe(false)
    expect(isValidPendingSwap({ ...validSwap, id: undefined })).toBe(false)
    expect(isValidPendingSwap({ ...validSwap, origin: "" })).toBe(false)
    expect(isValidPendingSwap({ ...validSwap, origin: "   " })).toBe(false)
    expect(isValidPendingSwap({ ...validSwap, origin: 123 })).toBe(false)
  })

  it("rejects missing or malformed params", () => {
    expect(
      isValidPendingSwap({ ...validSwap, params: null as unknown as PendingSwap["params"] })
    ).toBe(false)
    expect(
      isValidPendingSwap({ ...validSwap, params: undefined as unknown as PendingSwap["params"] })
    ).toBe(false)
    expect(
      isValidPendingSwap({ ...validSwap, params: "invalid" as unknown as PendingSwap["params"] })
    ).toBe(false)

    // Missing or invalid outputMint
    expect(
      isValidPendingSwap({ ...validSwap, params: { ...validSwap.params, outputMint: "" } })
    ).toBe(false)
    expect(
      isValidPendingSwap({ ...validSwap, params: { ...validSwap.params, outputMint: "   " } })
    ).toBe(false)
    expect(
      isValidPendingSwap({
        ...validSwap,
        params: { ...validSwap.params, outputMint: null as unknown as string }
      })
    ).toBe(false)

    // Missing, invalid, or non-positive amountLamports
    expect(
      isValidPendingSwap({ ...validSwap, params: { ...validSwap.params, amountLamports: "" } })
    ).toBe(false)
    expect(
      isValidPendingSwap({ ...validSwap, params: { ...validSwap.params, amountLamports: "0" } })
    ).toBe(false)
    expect(
      isValidPendingSwap({ ...validSwap, params: { ...validSwap.params, amountLamports: "-500" } })
    ).toBe(false)
    expect(
      isValidPendingSwap({ ...validSwap, params: { ...validSwap.params, amountLamports: "abc" } })
    ).toBe(false)

    // Invalid optional fields
    expect(
      isValidPendingSwap({ ...validSwap, params: { ...validSwap.params, slippageBps: NaN } })
    ).toBe(false)
    expect(
      isValidPendingSwap({
        ...validSwap,
        params: { ...validSwap.params, reshield: "true" as unknown as boolean }
      })
    ).toBe(false)
  })
})

describe("SwapApprove defense against malformed params (#257)", () => {
  it("renders SwapApprove without crashing when params are incomplete", () => {
    const html = renderToStaticMarkup(
      React.createElement(SwapApprove, {
        id: 1,
        origin: "https://dapp.paraloom.io",
        params: {} as never,
        onResolved: () => {}
      })
    )
    expect(html).toContain("Approve private swap")
    expect(html).toContain("dapp.paraloom.io")
  })
})
