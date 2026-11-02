// Defense-in-depth `mint <-> assetId` binding on the spend and token-swap
// paths. `verifiedMint` gates `/transact/scan` at discovery time, but a note
// already persisted with a mismatched or missing `mint` would otherwise:
//   1. prove against `assetId` while submitting the wrong 32-byte `mint` to
//      `/transact/submit` (guaranteed validator rejection), and
//   2. in `privateSwapFromToken`, withdraw `GAS_LAMPORTS` (0.009 SOL) of real
//      shielded SOL and fund an on-chain ATA before Step 3 ever checks the
//      token note's mint.

import { PublicKey, type Connection } from "@solana/web3.js"
import {
  addDiscoveredNote,
  addNote,
  getNotes,
  shieldedBalance,
  shieldedTokenBalances,
  type ShieldedNote
} from "~lib/paraloom/notes"
import { privateSwapFromToken } from "~lib/paraloom/privateSwap"
import { listSwapOutputs } from "~lib/paraloom/swapOutputs"
import { spendV3 } from "~lib/paraloom/transactFlow"
import * as nacl from "tweetnacl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { installFakeChrome } from "./support/chromeStorage"

const {
  assetIdForMint,
  fakeAssetIdForMint,
  proveTransact,
  v3MerklePath,
  v3NoteCommitment,
  v3NoteCommitmentAsset,
  v3NotePubkey
} = vi.hoisted(() => {
  const fakeAssetIdForMint = (mintHex: string) =>
    (mintHex.trim().toLowerCase().match(/../g) ?? [])
      .map((b) => (parseInt(b, 16) ^ 0x5a).toString(16).padStart(2, "0"))
      .join("")

  return {
    fakeAssetIdForMint,
    assetIdForMint: vi.fn(async (mintHex: string) => {
      if (!/^[0-9a-fA-F]*$/.test(mintHex.trim())) throw new Error("bad hex")
      if (mintHex.trim().length !== 64) throw new Error("expected 32-byte hex")
      return fakeAssetIdForMint(mintHex)
    }),
    v3NotePubkey: vi.fn(async (privkeyHex: string) => privkeyHex),
    v3NoteCommitment: vi.fn(async () => "aa".repeat(32)),
    v3NoteCommitmentAsset: vi.fn(async () => "bb".repeat(32)),
    v3MerklePath: vi.fn(async () => ({
      path: Array.from({ length: 32 }, () => "00".repeat(32)),
      root: "cc".repeat(32)
    })),
    proveTransact: vi.fn(async () =>
      JSON.stringify({
        nullifiers: ["01".repeat(32), "02".repeat(32)],
        output_commitments: ["03".repeat(32), "04".repeat(32)],
        proof: "05".repeat(64)
      })
    )
  }
})

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  assetIdForMint,
  proveTransact,
  v3MerklePath,
  v3NoteCommitment,
  v3NoteCommitmentAsset,
  v3NotePubkey
}))

const ACCOUNT = "paraloom1" + "11".repeat(64)
const SPEND_PRIVKEY = "12".repeat(32)
const RECIPIENT_SOLANA_HEX = "34".repeat(32)
const NATIVE_ASSET = "00".repeat(32)

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const USDC_MINT_HEX = Buffer.from(new PublicKey(USDC_MINT).toBytes()).toString("hex")
const USDC_ASSET = fakeAssetIdForMint(USDC_MINT_HEX)

// The two poisoned base58 mints produced by `verifiedMint` before the hex32 fix:
//   - System Program (`00` * 32) on Node `Buffer.from(" " + hex, "hex")` or
//     browser `buffer` with >=2 leading whitespace chars.
//   - 4-bit nibble-shifted pubkey on browser `buffer` with 1 leading space.
const SYSTEM_MINT = "11111111111111111111111111111111"
const NIBBLE_SHIFTED_MINT = "qYeA6v1G7vBH6Ev5ss9ZgkVuus5KaZsWq5cMBgn94Bw"

let ownBoxPubHex: string
let fetchMock: ReturnType<typeof vi.fn>

function makeFakeConnection() {
  const getSignaturesForAddress = vi.fn(async () => [])
  const sendRawTransaction = vi.fn(async () => "sig-ata-create")
  const getAccountInfo = vi.fn(async () => null)
  const getLatestBlockhash = vi.fn(async () => ({
    blockhash: SYSTEM_MINT,
    lastValidBlockHeight: 100
  }))
  const getSignatureStatus = vi.fn(async () => ({
    value: { err: null, confirmationStatus: "confirmed" as const }
  }))
  const getBalance = vi.fn(async () => 9_000_000)
  const getTokenAccountBalance = vi.fn(async () => ({
    value: { amount: "0" }
  }))

  return {
    connection: {
      getSignaturesForAddress,
      sendRawTransaction,
      getAccountInfo,
      getLatestBlockhash,
      getSignatureStatus,
      getBalance,
      getTokenAccountBalance
    } as unknown as Connection,
    getSignaturesForAddress,
    sendRawTransaction
  }
}

function splInput(overrides: Partial<ShieldedNote> = {}): ShieldedNote {
  return {
    amount: "500",
    blinding: "cd".repeat(32),
    assetId: USDC_ASSET,
    mint: USDC_MINT,
    signature: "",
    createdAt: 1,
    spent: false,
    commitment: "ef".repeat(32),
    source: "transfer",
    leafIndex: 0,
    ...overrides
  }
}

function solGasInput(overrides: Partial<ShieldedNote> = {}): ShieldedNote {
  return {
    amount: "10000000",
    blinding: "ab".repeat(32),
    assetId: NATIVE_ASSET,
    signature: "sig-gas-deposit",
    createdAt: 1,
    spent: false,
    source: "deposit",
    leafIndex: 0,
    ...overrides
  }
}

beforeEach(() => {
  installFakeChrome()
  ownBoxPubHex = Buffer.from(nacl.box.keyPair().publicKey).toString("hex")
  assetIdForMint.mockClear()
  proveTransact.mockClear()
  v3MerklePath.mockClear()
  v3NotePubkey.mockClear()
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ request_id: "req-1" }),
    text: async () => ""
  }))
  vi.stubGlobal("fetch", fetchMock)
})

describe("spendV3 mint <-> assetId invariant", () => {
  it.each([
    ["zero-padded System Program mint", SYSTEM_MINT],
    ["nibble-shifted browser polyfill mint", NIBBLE_SHIFTED_MINT]
  ])(
    "rejects a poisoned SPL note (%s) before rebuilding leaves, proving, or submitting",
    async (_label, poisonedMint) => {
      const { connection, getSignaturesForAddress } = makeFakeConnection()

      await expect(
        spendV3(
          connection,
          ACCOUNT,
          SPEND_PRIVKEY,
          ownBoxPubHex,
          [splInput({ mint: poisonedMint })],
          500n,
          { kind: "withdraw", recipientSolanaHex: RECIPIENT_SOLANA_HEX },
          { confirmSettled: async () => false }
        )
      ).rejects.toThrow(/mint does not match its assetId/)

      expect(getSignaturesForAddress).not.toHaveBeenCalled()
      expect(proveTransact).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

  it("rejects a 2-note SPL spend when the second note carries a different mint", async () => {
    const { connection, getSignaturesForAddress } = makeFakeConnection()

    await expect(
      spendV3(
        connection,
        ACCOUNT,
        SPEND_PRIVKEY,
        ownBoxPubHex,
        [
          splInput({ commitment: "e1".repeat(32), mint: USDC_MINT, leafIndex: 0 }),
          splInput({ commitment: "e2".repeat(32), mint: SYSTEM_MINT, leafIndex: 1 })
        ],
        600n,
        { kind: "withdraw", recipientSolanaHex: RECIPIENT_SOLANA_HEX },
        { confirmSettled: async () => false }
      )
    ).rejects.toThrow(/all spent SPL notes must share one mint/)

    expect(getSignaturesForAddress).not.toHaveBeenCalled()
    expect(proveTransact).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects a 2-note SPL spend when the second note is missing its mint", async () => {
    const { connection, getSignaturesForAddress } = makeFakeConnection()

    await expect(
      spendV3(
        connection,
        ACCOUNT,
        SPEND_PRIVKEY,
        ownBoxPubHex,
        [
          splInput({ commitment: "e1".repeat(32), mint: USDC_MINT, leafIndex: 0 }),
          splInput({ commitment: "e2".repeat(32), mint: undefined, leafIndex: 1 })
        ],
        600n,
        { kind: "withdraw", recipientSolanaHex: RECIPIENT_SOLANA_HEX },
        { confirmSettled: async () => false }
      )
    ).rejects.toThrow(/must carry its mint/)

    expect(getSignaturesForAddress).not.toHaveBeenCalled()
    expect(proveTransact).not.toHaveBeenCalled()
  })

  it("rejects a native SOL note that carries an SPL mint", async () => {
    const { connection, getSignaturesForAddress } = makeFakeConnection()

    await expect(
      spendV3(
        connection,
        ACCOUNT,
        SPEND_PRIVKEY,
        ownBoxPubHex,
        [solGasInput({ mint: USDC_MINT })],
        1_000_000n,
        { kind: "withdraw", recipientSolanaHex: RECIPIENT_SOLANA_HEX },
        { confirmSettled: async () => false }
      )
    ).rejects.toThrow(/native SOL note must not carry an SPL mint/)

    expect(getSignaturesForAddress).not.toHaveBeenCalled()
    expect(proveTransact).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("settles a valid SPL spend with change, submitting canonical mintHex and persisting canonical base58 mint on change", async () => {
    const { connection } = makeFakeConnection()
    const input = splInput({ commitment: "ef".repeat(32), amount: "500" })
    await addDiscoveredNote(ACCOUNT, input)

    const res = await spendV3(
      connection,
      ACCOUNT,
      SPEND_PRIVKEY,
      ownBoxPubHex,
      [input],
      300n,
      { kind: "withdraw", recipientSolanaHex: RECIPIENT_SOLANA_HEX },
      { confirmSettled: async () => true }
    )

    expect(res).toEqual({
      requestId: "req-1",
      changeLamports: 200n,
      settled: true
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [, submitInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    const submittedBody = JSON.parse(submitInit.body as string) as { mint?: string }
    expect(submittedBody.mint).toBe(USDC_MINT_HEX)

    const notes = await getNotes(ACCOUNT)
    expect(notes).toHaveLength(2)
    expect(notes.find((n) => n.commitment === "ef".repeat(32))?.spent).toBe(true)
    const changeNote = notes.find((n) => n.amount === "200")
    expect(changeNote).toMatchObject({
      amount: "200",
      assetId: USDC_ASSET,
      mint: USDC_MINT,
      spent: false
    })
    expect(await shieldedTokenBalances(ACCOUNT)).toEqual({ [USDC_MINT]: 200n })
  })
})

describe("privateSwapFromToken pre-gas mint binding", () => {
  it.each([
    ["zero-padded System Program mint", SYSTEM_MINT],
    ["nibble-shifted browser polyfill mint", NIBBLE_SHIFTED_MINT]
  ])(
    "rejects poisoned tokenInputs (%s) before saving swap output, withdrawing gas SOL, or creating an ATA",
    async (_label, poisonedMint) => {
      const { connection, sendRawTransaction } = makeFakeConnection()
      const gasNote = solGasInput()
      await addNote(ACCOUNT, gasNote)

      vi.useFakeTimers()
      try {
        const promise = privateSwapFromToken(
          connection,
          ACCOUNT,
          SPEND_PRIVKEY,
          ownBoxPubHex,
          [splInput({ mint: poisonedMint })],
          [gasNote],
          {
            inputMint: USDC_MINT,
            amountTokenUnits: 500n,
            outputMint: "SOL",
            reshield: true
          }
        )
        await Promise.all([
          expect(promise).rejects.toThrow(/token input note mint does not match inputMint/),
          vi.runAllTimersAsync()
        ])
      } finally {
        vi.useRealTimers()
      }

      expect(await listSwapOutputs()).toEqual([])
      expect(proveTransact).not.toHaveBeenCalled()
      expect(sendRawTransaction).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(await shieldedBalance(ACCOUNT)).toBe(10_000_000n)
    }
  )

  it("rejects tokenInputs whose assetId does not match inputMint before withdrawing gas SOL", async () => {
    const { connection, sendRawTransaction } = makeFakeConnection()
    const gasNote = solGasInput()
    await addNote(ACCOUNT, gasNote)

    vi.useFakeTimers()
    try {
      const promise = privateSwapFromToken(
        connection,
        ACCOUNT,
        SPEND_PRIVKEY,
        ownBoxPubHex,
        [splInput({ assetId: "99".repeat(32), mint: USDC_MINT })],
        [gasNote],
        {
          inputMint: USDC_MINT,
          amountTokenUnits: 500n,
          outputMint: "SOL",
          reshield: true
        }
      )
      await Promise.all([
        expect(promise).rejects.toThrow(/token input note assetId does not match inputMint/),
        vi.runAllTimersAsync()
      ])
    } finally {
      vi.useRealTimers()
    }

    expect(await listSwapOutputs()).toEqual([])
    expect(proveTransact).not.toHaveBeenCalled()
    expect(sendRawTransaction).not.toHaveBeenCalled()
    expect(await shieldedBalance(ACCOUNT)).toBe(10_000_000n)
  })
})
