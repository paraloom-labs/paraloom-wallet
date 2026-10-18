import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({ NATIVE_ASSET_HEX: "00".repeat(32) }))

import { retryingFetch } from "~lib/paraloom/bridge"
import { fetchPrices, SOL_MINT } from "~lib/paraloom/prices"
import {
  dismissSwapOutput,
  listSwapOutputs,
  saveSwapOutput,
  type SwapOutput
} from "~lib/paraloom/swapOutputs"
import type { EncryptedWallet } from "~lib/crypto/keyManagement"
import type { Account } from "~lib/store/walletStore"
import {
  getAutoLockMinutes,
  getNetwork,
  getStoredWallet,
  isWalletLocked,
  migrateWalletToScrypt,
  saveEncryptedWallet,
  setAutoLockMinutes,
  setLockState,
  setNetwork,
  updateAccounts
} from "~lib/storage/secure"
import { installFakeChrome } from "./support/chromeStorage"

const SHIELDED_ACCOUNT = "paraloom1" + "aa".repeat(64)

function makeSwapRecord(
  freshAddress: string,
  overrides: Partial<SwapOutput> = {}
): SwapOutput {
  return {
    freshAddress,
    freshSecretKeyHex: "11".repeat(64),
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    outAmount: 0,
    swapSignature: "",
    createdAt: 1_700_000_000_000,
    ...overrides
  }
}

beforeEach(() => {
  installFakeChrome()
})

describe("swapOutputs atomic serialization and non-destructive merge", () => {
  it("preserves all swap outputs under concurrent saveSwapOutput calls with async storage delay", async () => {
    const origGet = chrome.storage.local.get.bind(chrome.storage.local)
    vi.spyOn(chrome.storage.local, "get").mockImplementation(async (key) => {
      await new Promise((r) => setTimeout(r, 10))
      return origGet(key as string)
    })

    await Promise.all([
      saveSwapOutput(makeSwapRecord("FreshAddr1", { createdAt: 100 })),
      saveSwapOutput(makeSwapRecord("FreshAddr2", { createdAt: 200 })),
      saveSwapOutput(makeSwapRecord("FreshAddr3", { createdAt: 300 }))
    ])

    const list = await listSwapOutputs()
    expect(list.map((r) => r.freshAddress).sort()).toEqual([
      "FreshAddr1",
      "FreshAddr2",
      "FreshAddr3"
    ])
  })

  it("serializes concurrent saveSwapOutput and dismissSwapOutput without losing new swaps or resurrecting dismissed ones", async () => {
    await saveSwapOutput(makeSwapRecord("ToDismiss", { createdAt: 100 }))

    const origGet = chrome.storage.local.get.bind(chrome.storage.local)
    vi.spyOn(chrome.storage.local, "get").mockImplementation(async (key) => {
      await new Promise((r) => setTimeout(r, 10))
      return origGet(key as string)
    })

    await Promise.all([
      dismissSwapOutput("ToDismiss"),
      saveSwapOutput(makeSwapRecord("NewActiveSwap", { createdAt: 200 }))
    ])

    const list = await listSwapOutputs()
    expect(list.map((r) => r.freshAddress)).toEqual(["NewActiveSwap"])
  })

  it("never clobbers swapSignature, positive outAmount, reshield, or reshieldRecovered when a stale snapshot saves later", async () => {
    // 1. Pre-save with reshield: true
    await saveSwapOutput(
      makeSwapRecord("FreshReshield", {
        outAmount: 0,
        swapSignature: "",
        reshield: true,
        reshieldRecovered: false
      })
    )

    // 2. Swap lands and re-shield recovery marks reshieldRecovered: true
    await saveSwapOutput(
      makeSwapRecord("FreshReshield", {
        outAmount: 2_500_000,
        swapSignature: "sig-landed-123",
        reshield: true,
        reshieldRecovered: true
      })
    )

    // 3. A stale in-flight caller writes an older snapshot with empty signature, 0 amount, and omitted reshield flags
    await saveSwapOutput({
      freshAddress: "FreshReshield",
      freshSecretKeyHex: "",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outAmount: 0,
      swapSignature: "",
      createdAt: 1_700_000_000_000
    })

    const [saved] = await listSwapOutputs()
    expect(saved.freshSecretKeyHex).toBe("11".repeat(64))
    expect(saved.swapSignature).toBe("sig-landed-123")
    expect(saved.outAmount).toBe(2_500_000)
    expect(saved.reshield).toBe(true)
    expect(saved.reshieldRecovered).toBe(true)
  })
})

describe("lib/storage/secure.ts atomic wallet mutations", () => {
  it("preserves all fields when migrateWalletToScrypt, setLockState, updateAccounts, setNetwork, and setAutoLockMinutes run concurrently", async () => {
    const v1Encrypted: EncryptedWallet = {
      encrypted: "ciphertext-v1",
      nonce: "nonce-v1",
      salt: "salt-v1"
    }
    const v2Encrypted: EncryptedWallet = {
      encrypted: "ciphertext-v2",
      nonce: "nonce-v2",
      salt: "salt-v2"
    }
    const makeAccount = (index: number, address: string): Account => ({
      index,
      name: `Account ${index + 1}`,
      balance: 0n,
      keypair: {
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(64),
        shieldedAddress: address,
        boxPublicKey: new Uint8Array(32),
        boxSecretKey: new Uint8Array(32),
        spendPrivkey: new Uint8Array(32)
      }
    })

    await saveEncryptedWallet(v1Encrypted, SHIELDED_ACCOUNT, undefined, undefined, [
      makeAccount(0, SHIELDED_ACCOUNT)
    ])

    const origGet = chrome.storage.local.get.bind(chrome.storage.local)
    vi.spyOn(chrome.storage.local, "get").mockImplementation(async (key) => {
      await new Promise((r) => setTimeout(r, 10))
      return origGet(key as string)
    })

    await Promise.all([
      migrateWalletToScrypt(v2Encrypted, undefined, "password123"),
      setLockState(false),
      setNetwork("devnet"),
      setAutoLockMinutes(30),
      updateAccounts([
        makeAccount(0, SHIELDED_ACCOUNT),
        makeAccount(1, "paraloom1" + "bb".repeat(64))
      ])
    ])

    const stored = await getStoredWallet()
    expect(stored).not.toBeNull()
    expect(stored!.encryptedData.encrypted).toBe("ciphertext-v2")
    expect(stored!.kdfVersion).toBe(1)
    expect(stored!.accounts).toHaveLength(2)
    expect(await isWalletLocked()).toBe(false)
    expect(await getNetwork()).toBe("devnet")
    expect(await getAutoLockMinutes()).toBe(30)
  })
})

describe("retryingFetch rate-limit and timeout resilience", () => {
  it("retries HTTP 429 and 408 responses before succeeding", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "0" }
        })
      )
      .mockResolvedValueOnce(new Response("timeout", { status: 408 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))

    const res = await retryingFetch("https://api.devnet.solana.com")
    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    fetchSpy.mockRestore()
  })

  it("does not retry non-retryable 4xx client errors like 400 or 404", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }))

    const res = await retryingFetch("https://api.devnet.solana.com")
    expect(res.status).toBe(400)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    fetchSpy.mockRestore()
  })
})

describe("fetchPrices numeric validation and URL encoding", () => {
  it("filters out NaN, Infinity, and negative usdPrice values and sanitizes non-finite priceChange24h", async () => {
    const customFetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        [SOL_MINT]: { usdPrice: 155.25, priceChange24h: Number.NaN },
        MintNeg: { usdPrice: -10, priceChange24h: 1.5 },
        MintInf: { usdPrice: Number.POSITIVE_INFINITY, priceChange24h: 0 },
        MintNaN: { usdPrice: Number.NaN, priceChange24h: 0 }
      })
    } as Response)

    const prices = await fetchPrices(["MintNeg", "MintInf", "MintNaN"])
    expect(prices[SOL_MINT]).toEqual({ usdPrice: 155.25, priceChange24h: 0 })
    expect(prices["MintNeg"]).toBeUndefined()
    expect(prices["MintInf"]).toBeUndefined()
    expect(prices["MintNaN"]).toBeUndefined()

    customFetchSpy.mockRestore()
  })

  it("URL-encodes mint identifiers when building the query string", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({})
    } as Response)

    await fetchPrices(["mint&inject=1"])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const calledUrl = String(fetchSpy.mock.calls[0][0])
    expect(calledUrl).toContain("mint%26inject%3D1")
    expect(calledUrl).not.toContain("&inject=1")

    fetchSpy.mockRestore()
  })
})
