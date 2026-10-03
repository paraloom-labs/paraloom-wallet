import { Keypair, PublicKey, type Connection } from "@solana/web3.js"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { depositSpl } from "~lib/paraloom/bridge"
import {
  getNotes,
  shieldedBalance,
  shieldedTokenBalances
} from "~lib/paraloom/notes"
import { persistReshieldedNote, recoverReshields } from "~lib/paraloom/reshieldRecovery"
import { listSwapOutputs, saveSwapOutput } from "~lib/paraloom/swapOutputs"
import { sendDepositNote } from "~lib/paraloom/transact"
import { installFakeChrome } from "./support/chromeStorage"

// Prover wasm mock
vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  assetIdForMint: vi.fn(async (mintHex: string) => "11".repeat(32))
}))

const ACCOUNT = "paraloom1" + "11".repeat(64)
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
const FAKE_BLOCKHASH = "4vJ9JU1bJJE96Knqd41m5GPreREdupEghUjedvZJuoxK"

function fakeConnection(opts: {
  signatureStatus?: any
  balanceLamports?: number
  tokenBalance?: string
}) {
  return {
    getLatestBlockhash: vi.fn(async () => ({ blockhash: FAKE_BLOCKHASH })),
    sendRawTransaction: vi.fn(async () => "mock-tx-sig"),
    getSignatureStatus: vi.fn(async () => ({
      value: opts.signatureStatus ?? null
    })),
    getBalance: vi.fn(async () => opts.balanceLamports ?? 0),
    getTokenAccountBalance: vi.fn(async () => ({
      value: { amount: opts.tokenBalance ?? "0" }
    })),
    getAccountInfo: vi.fn(async () => null),
    getSignaturesForAddress: vi.fn(async () => [])
  } as unknown as Connection
}

beforeEach(() => {
  installFakeChrome()
})

describe("deposit confirmation timeout regression (paraloom-core#853)", () => {
  it("depositSpl throws on confirmation timeout and keeps pending note out of confirmed balance", async () => {
    const conn = fakeConnection({ signatureStatus: null })
    const depositor = Keypair.generate()
    const amount = 1_000_000n // 1 USDC
    const assetId = "11".repeat(32)

    let submittedRan = false
    await expect(
      depositSpl(
        conn,
        depositor,
        ACCOUNT,
        USDC_MINT,
        amount,
        assetId,
        undefined,
        async (result) => {
          submittedRan = true
          await persistReshieldedNote(ACCOUNT, {
            assetId,
            mint: USDC_MINT.toBase58(),
            amount: amount.toString(),
            blindingHex: Buffer.from(result.blinding).toString("hex"),
            depositSignature: result.signature,
            pending: true
          })
        },
        10 // 10ms timeout for test
      )
    ).rejects.toThrow(/not confirmed within the timeout/)

    // 1. Blinding is safely preserved in storage for recovery
    expect(submittedRan).toBe(true)
    const notes = await getNotes(ACCOUNT)
    expect(notes).toHaveLength(1)
    expect(notes[0].pending).toBe(true)
    expect(notes[0].amount).toBe("1000000")

    // 2. Unconfirmed note is NOT counted in shieldedTokenBalances
    expect(await shieldedTokenBalances(ACCOUNT)).toEqual({})

    // 3. Later retry succeeds and confirms with new signature
    const confirmedConn = fakeConnection({
      signatureStatus: { confirmationStatus: "confirmed" }
    })
    confirmedConn.sendRawTransaction = vi.fn(async () => "confirmed-retry-sig")

    const result = await depositSpl(
      confirmedConn,
      depositor,
      ACCOUNT,
      USDC_MINT,
      amount,
      assetId,
      undefined,
      async (r) => {
        await persistReshieldedNote(ACCOUNT, {
          assetId,
          mint: USDC_MINT.toBase58(),
          amount: amount.toString(),
          blindingHex: Buffer.from(r.blinding).toString("hex"),
          depositSignature: r.signature,
          pending: true
        })
      },
      1000
    )
    expect(result.signature).toBe("confirmed-retry-sig")

    // Mark confirmed note
    await persistReshieldedNote(ACCOUNT, {
      assetId,
      mint: USDC_MINT.toBase58(),
      amount: amount.toString(),
      blindingHex: Buffer.from(result.blinding).toString("hex"),
      depositSignature: result.signature,
      pending: false
    })

    // Balance reflects exactly 1 confirmed note (1,000,000 units), not double-counted (2,000,000)
    expect(await shieldedTokenBalances(ACCOUNT)).toEqual({
      [USDC_MINT.toBase58()]: 1_000_000n
    })
  })

  it("sendDepositNote throws on confirmation timeout and keeps native note out of shieldedBalance", async () => {
    const conn = fakeConnection({ signatureStatus: null })
    const payer = Keypair.generate()
    const lamports = 5_000_000n

    let submittedRan = false
    await expect(
      sendDepositNote(
        conn,
        payer,
        lamports,
        new Uint8Array(32),
        new Uint8Array(32),
        async (sig) => {
          submittedRan = true
          const { addNote } = await import("~lib/paraloom/notes")
          await addNote(ACCOUNT, {
            amount: lamports.toString(),
            blinding: "22".repeat(32),
            assetId: "00".repeat(32),
            signature: sig,
            createdAt: Date.now(),
            spent: false,
            source: "deposit",
            pending: true
          })
        },
        10
      )
    ).rejects.toThrow(/not confirmed within the timeout/)

    expect(submittedRan).toBe(true)
    const notes = await getNotes(ACCOUNT)
    expect(notes).toHaveLength(1)
    expect(notes[0].pending).toBe(true)

    // Unconfirmed deposit does NOT count toward spendable shielded balance
    expect(await shieldedBalance(ACCOUNT)).toBe(0n)
  })

  it("recoverReshields does not mark row recovered when depositSpl times out", async () => {
    const fresh = Keypair.generate()
    const freshHex = Buffer.from(fresh.secretKey).toString("hex")

    await saveSwapOutput({
      freshAddress: fresh.publicKey.toBase58(),
      freshSecretKeyHex: freshHex,
      outputMint: USDC_MINT.toBase58(),
      outAmount: 500_000,
      swapSignature: "swap-sig-done",
      reshield: true,
      createdAt: Date.now() - 60_000
    })

    // Mock connection where ATA holds tokens but deposit confirmation times out
    const conn = fakeConnection({
      tokenBalance: "500000",
      signatureStatus: null
    })

    const recoveredCount = await recoverReshields(conn, ACCOUNT, 10)
    expect(recoveredCount).toBe(0)

    // Swap row was NOT marked recovered because depositSpl did not confirm
    const [row] = await listSwapOutputs()
    expect(row.reshieldRecovered).toBeFalsy()

    // And balance is not polluted
    expect(await shieldedTokenBalances(ACCOUNT)).toEqual({})
  })
})
