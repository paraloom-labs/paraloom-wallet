import { Connection, Keypair, PublicKey } from "@solana/web3.js"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  assetIdForMint: vi.fn((mintBytes: Uint8Array) =>
    Buffer.from(mintBytes).toString("hex")
  ),
  v3NoteCommitmentAsset: vi.fn(
    async (
      value: bigint,
      pubkeyHex: string,
      blindingHex: string,
      assetIdHex: string
    ) =>
      `${value.toString(16).padStart(16, "0")}${pubkeyHex.slice(0, 16)}${blindingHex.slice(0, 16)}${assetIdHex.slice(0, 16)}`
  )
}))

import { addressSpendPubHex } from "~lib/crypto/keyManagement"
import {
  buildDepositSplInstruction,
  recoverReshieldedNote
} from "~lib/paraloom/bridge"
import { getNotes, shieldedTokenBalances } from "~lib/paraloom/notes"
import {
  persistReshieldedNote,
  recoverReshields
} from "~lib/paraloom/reshieldRecovery"
import {
  listSwapOutputs,
  saveSwapOutput,
  swapOutputBelongsTo
} from "~lib/paraloom/swapOutputs"
import {
  reconcileSwapOutputs,
  RESUME_GRACE_MS
} from "~lib/paraloom/swapReconcile"

import { installFakeChrome } from "./support/chromeStorage"

const ACCOUNT_A = "paraloom1" + "11".repeat(32) + "aa".repeat(32)
const ACCOUNT_B = "paraloom1" + "22".repeat(32) + "bb".repeat(32)
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

beforeEach(() => {
  installFakeChrome()
})

describe("SwapOutput multi-account scoping", () => {
  it("filters listSwapOutputs by owning shieldedAddress while keeping legacy rows visible", async () => {
    const freshA = Keypair.generate()
    const freshB = Keypair.generate()
    const freshLegacy = Keypair.generate()

    await saveSwapOutput({
      freshAddress: freshA.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(freshA.secretKey).toString("hex"),
      shieldedAddress: ACCOUNT_A,
      outputMint: USDC_MINT,
      outAmount: 1_000_000,
      swapSignature: "sig-a",
      createdAt: 1
    })
    await saveSwapOutput({
      freshAddress: freshB.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(freshB.secretKey).toString("hex"),
      shieldedAddress: ACCOUNT_B,
      outputMint: USDC_MINT,
      outAmount: 2_000_000,
      swapSignature: "sig-b",
      createdAt: 2
    })
    await saveSwapOutput({
      freshAddress: freshLegacy.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(freshLegacy.secretKey).toString("hex"),
      outputMint: USDC_MINT,
      outAmount: 3_000_000,
      swapSignature: "sig-legacy",
      createdAt: 3
    })

    const forA = await listSwapOutputs(ACCOUNT_A)
    expect(forA.map((o) => o.swapSignature)).toEqual(["sig-a", "sig-legacy"])

    const forB = await listSwapOutputs(ACCOUNT_B)
    expect(forB.map((o) => o.swapSignature)).toEqual(["sig-b", "sig-legacy"])

    expect(
      swapOutputBelongsTo(
        {
          freshAddress: freshA.publicKey.toBase58(),
          freshSecretKeyHex: "",
          shieldedAddress: ACCOUNT_A,
          outputMint: USDC_MINT,
          outAmount: 0,
          swapSignature: "",
          createdAt: 1
        },
        ACCOUNT_B
      )
    ).toBe(false)
  })
})

describe("recoverReshieldedNote & recoverReshields cross-account isolation", () => {
  function fakeConnectionWithDepositSpl(
    depositor: PublicKey,
    mint: PublicKey,
    amount: bigint,
    recipientPubkeyHex: string,
    blindingHex: string,
    depositSig = "5reshieldSig1111111111111111111111111111111111111111"
  ): Connection {
    const ix = buildDepositSplInstruction(
      depositor,
      mint,
      depositor,
      amount,
      Uint8Array.from(Buffer.from(recipientPubkeyHex, "hex")),
      Uint8Array.from(Buffer.from(blindingHex, "hex"))
    )
    return {
      getSignaturesForAddress: async () => [{ signature: depositSig }],
      getTransaction: async () => ({
        meta: { err: null },
        transaction: {
          message: {
            staticAccountKeys: [ix.programId],
            compiledInstructions: [
              {
                programIdIndex: 0,
                data: Uint8Array.from(ix.data)
              }
            ]
          }
        }
      })
    } as unknown as Connection
  }

  it("extracts amount, recipient pubkeyHex, and blindingHex from deposit_note_spl", async () => {
    const fresh = Keypair.generate()
    const mint = new PublicKey(USDC_MINT)
    const pubkeyHex = addressSpendPubHex(ACCOUNT_A)
    const blindingHex = "01".repeat(32)
    const conn = fakeConnectionWithDepositSpl(
      fresh.publicKey,
      mint,
      750_000n,
      pubkeyHex,
      blindingHex
    )

    const rec = await recoverReshieldedNote(conn, fresh.publicKey.toBase58())
    expect(rec).toEqual({
      amount: "750000",
      pubkeyHex,
      blindingHex,
      signature: "5reshieldSig1111111111111111111111111111111111111111"
    })
  })

  it("refuses to book Account A's on-chain reshield into Account B (even on legacy unscoped rows) and preserves recovery for Account A", async () => {
    const fresh = Keypair.generate()
    const mint = new PublicKey(USDC_MINT)
    const blindingHex = "02".repeat(32)

    // Legacy row without `shieldedAddress`, whose on-chain deposit_note_spl
    // committed the note to ACCOUNT_A's spend pubkey.
    await saveSwapOutput({
      freshAddress: fresh.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(fresh.secretKey).toString("hex"),
      outputMint: USDC_MINT,
      outAmount: 500_000,
      swapSignature: "swap-sig-1",
      reshield: true,
      createdAt: 10
    })

    const conn = fakeConnectionWithDepositSpl(
      fresh.publicKey,
      mint,
      500_000n,
      addressSpendPubHex(ACCOUNT_A),
      blindingHex
    )

    // Popup opens while ACCOUNT_B is active: must NOT poison ACCOUNT_B or mark recovered.
    const recoveredForB = await recoverReshields(conn, ACCOUNT_B)
    expect(recoveredForB).toBe(0)
    expect(await getNotes(ACCOUNT_B)).toEqual([])
    const afterB = await listSwapOutputs()
    expect(afterB[0].reshieldRecovered).toBeUndefined()

    // Switching back to ACCOUNT_A recovers the note cleanly and computes its commitment.
    const recoveredForA = await recoverReshields(conn, ACCOUNT_A)
    expect(recoveredForA).toBe(1)
    expect(await shieldedTokenBalances(ACCOUNT_A)).toEqual({
      [USDC_MINT]: 500_000n
    })
    const notesA = await getNotes(ACCOUNT_A)
    expect(notesA).toHaveLength(1)
    expect(notesA[0].commitment).toMatch(/^[0-9a-f]{64}$/)
    const afterA = await listSwapOutputs()
    expect(afterA[0].reshieldRecovered).toBe(true)
    expect(afterA[0].shieldedAddress).toBe(ACCOUNT_A)
  })

  it("populates commitment in persistReshieldedNote so phantom SPL deposits can be reconciled", async () => {
    await persistReshieldedNote(ACCOUNT_A, {
      assetId: "00".repeat(31) + "01",
      mint: USDC_MINT,
      amount: "1000000",
      blindingHex: "03".repeat(32),
      depositSignature: "sig-spl-1"
    })
    const notes = await getNotes(ACCOUNT_A)
    expect(notes).toHaveLength(1)
    expect(notes[0].commitment).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("reconcileSwapOutputs cross-account isolation", () => {
  it("skips pending SwapOutput rows owned by another account", async () => {
    const fresh = Keypair.generate()
    await saveSwapOutput({
      freshAddress: fresh.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(fresh.secretKey).toString("hex"),
      shieldedAddress: ACCOUNT_A,
      outputMint: USDC_MINT,
      outAmount: 0,
      swapSignature: "",
      reshield: true,
      createdAt: Date.now() - RESUME_GRACE_MS - 10_000
    })

    let rpcCalls = 0
    const conn = {
      getBalance: async () => {
        rpcCalls++
        return 20_000_000
      }
    } as unknown as Connection

    const resolved = await reconcileSwapOutputs(conn, ACCOUNT_B)
    expect(resolved).toBe(0)
    expect(rpcCalls).toBe(0)
  })
})
