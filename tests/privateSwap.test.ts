// Tests for the #300 router-swap validation: a router-supplied transaction
// must never be signed blind. The drain the issue describes (a transfer of
// the fresh address's balance to an attacker account, wrapped in a plausible
// swap) is built here as a real VersionedTransaction and must be rejected
// before signing; a well-formed Jupiter swap shape must pass.

import { describe, expect, it } from "vitest"

import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js"

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID
} from "../lib/paraloom/constants"
import { WSOL_MINT } from "../lib/paraloom/swapReconcileClassify"
import {
  associatedTokenAddress,
  JUPITER_AGGREGATOR_V6_PROGRAM_ID,
  validateAndSignSwapTransaction,
  validateSwapTransaction,
  verifySwapSimulation,
  type SwapTxExpectations
} from "../lib/paraloom/swapTxValidation"

const JUPITER = new PublicKey(JUPITER_AGGREGATOR_V6_PROGRAM_ID)
const TOKEN = new PublicKey(TOKEN_PROGRAM_ID)
const ATA_PROGRAM = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID)
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
const INPUT_LAMPORTS = 1_000_000n
const QUOTED_OUT = 500_000

function buildTx(
  payer: Keypair,
  instructions: TransactionInstruction[]
): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    // Any 32-byte base58 value works as a stand-in blockhash for construction.
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions
  }).compileToV0Message()
  return new VersionedTransaction(message)
}

function jupiterIx(fresh: Keypair, inputAta: PublicKey, outputAta: PublicKey) {
  return new TransactionInstruction({
    programId: JUPITER,
    keys: [
      { pubkey: fresh.publicKey, isSigner: true, isWritable: true },
      { pubkey: inputAta, isSigner: false, isWritable: true },
      { pubkey: outputAta, isSigner: false, isWritable: true }
    ],
    data: Buffer.from([0])
  })
}

function syncNativeIx(wsolAta: PublicKey) {
  return new TransactionInstruction({
    programId: TOKEN,
    keys: [{ pubkey: wsolAta, isSigner: false, isWritable: true }],
    data: Buffer.from([17])
  })
}

function closeWsolIx(wsolAta: PublicKey, fresh: Keypair) {
  return new TransactionInstruction({
    programId: TOKEN,
    keys: [
      { pubkey: wsolAta, isSigner: false, isWritable: true },
      { pubkey: fresh.publicKey, isSigner: false, isWritable: true },
      { pubkey: fresh.publicKey, isSigner: true, isWritable: false }
    ],
    data: Buffer.from([9])
  })
}

function createAtaIx(payer: Keypair, ata: PublicKey, owner: PublicKey, mint: PublicKey) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN, isSigner: false, isWritable: false }
    ],
    data: Buffer.alloc(0)
  })
}

function transferCheckedIx(
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint
) {
  const data = Buffer.alloc(10)
  data[0] = 12
  data.writeBigUInt64LE(amount, 1)
  data[9] = 6 // decimals (USDC)
  return new TransactionInstruction({
    programId: TOKEN,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false }
    ],
    data
  })
}

/** A well-formed SOL -> USDC Jupiter swap shape for `fresh`. */
function validSolSwapTx(fresh: Keypair) {
  const wsolAta = associatedTokenAddress(fresh.publicKey, new PublicKey(WSOL_MINT))
  const outputAta = associatedTokenAddress(fresh.publicKey, USDC_MINT)
  return buildTx(fresh, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    createAtaIx(fresh, outputAta, fresh.publicKey, USDC_MINT),
    SystemProgram.transfer({
      fromPubkey: fresh.publicKey,
      toPubkey: wsolAta,
      lamports: Number(INPUT_LAMPORTS)
    }),
    syncNativeIx(wsolAta),
    jupiterIx(fresh, wsolAta, outputAta)
  ])
}

function solExpectations(fresh: Keypair): SwapTxExpectations {
  return {
    fresh: fresh.publicKey,
    inputMint: "SOL",
    inputAmount: INPUT_LAMPORTS,
    outputMint: USDC_MINT.toBase58(),
    quotedOutAmount: QUOTED_OUT,
    slippageBps: 100
  }
}

describe("validateSwapTransaction", () => {
  it("accepts a well-formed SOL -> USDC Jupiter swap", () => {
    const fresh = Keypair.generate()
    expect(() =>
      validateSwapTransaction(validSolSwapTx(fresh), solExpectations(fresh))
    ).not.toThrow()
  })

  it("rejects the #300 drain: SOL transferred to an attacker account", () => {
    const fresh = Keypair.generate()
    const attacker = Keypair.generate().publicKey
    const wsolAta = associatedTokenAddress(fresh.publicKey, new PublicKey(WSOL_MINT))
    const outputAta = associatedTokenAddress(fresh.publicKey, USDC_MINT)
    const tx = buildTx(fresh, [
      // The drain, dressed up with a Jupiter instruction alongside it.
      SystemProgram.transfer({
        fromPubkey: fresh.publicKey,
        toPubkey: attacker,
        lamports: 5_000_000
      }),
      jupiterIx(fresh, wsolAta, outputAta)
    ])
    expect(() => validateSwapTransaction(tx, solExpectations(fresh))).toThrow(
      /not the fresh address's wSOL account/
    )
  })

  it("rejects a drain that wraps MORE than the swap input (over-swap)", () => {
    const fresh = Keypair.generate()
    const wsolAta = associatedTokenAddress(fresh.publicKey, new PublicKey(WSOL_MINT))
    const outputAta = associatedTokenAddress(fresh.publicKey, USDC_MINT)
    const tx = buildTx(fresh, [
      SystemProgram.transfer({
        fromPubkey: fresh.publicKey,
        toPubkey: wsolAta,
        lamports: Number(INPUT_LAMPORTS) * 5
      }),
      syncNativeIx(wsolAta),
      jupiterIx(fresh, wsolAta, outputAta)
    ])
    expect(() => validateSwapTransaction(tx, solExpectations(fresh))).toThrow(
      /not the swap input amount/
    )
  })

  it("rejects a top-level SPL transferChecked to an attacker account", () => {
    const fresh = Keypair.generate()
    const attacker = Keypair.generate().publicKey
    const inputAta = associatedTokenAddress(fresh.publicKey, USDC_MINT)
    const outputAta = associatedTokenAddress(fresh.publicKey, new PublicKey(WSOL_MINT))
    const tx = buildTx(fresh, [
      transferCheckedIx(inputAta, USDC_MINT, attacker, fresh.publicKey, 500_000n),
      jupiterIx(fresh, inputAta, outputAta)
    ])
    expect(() =>
      validateSwapTransaction(tx, {
        fresh: fresh.publicKey,
        inputMint: USDC_MINT.toBase58(),
        inputAmount: 500_000n,
        outputMint: "SOL",
        quotedOutAmount: 100_000
      })
    ).toThrow(/top-level token transfer/)
  })

  it("rejects a transaction requiring a second signer", () => {
    const fresh = Keypair.generate()
    const other = Keypair.generate().publicKey
    const wsolAta = associatedTokenAddress(fresh.publicKey, new PublicKey(WSOL_MINT))
    const outputAta = associatedTokenAddress(fresh.publicKey, USDC_MINT)
    const tx = buildTx(fresh, [
      new TransactionInstruction({
        programId: JUPITER,
        keys: [
          { pubkey: fresh.publicKey, isSigner: true, isWritable: true },
          { pubkey: other, isSigner: true, isWritable: false },
          { pubkey: wsolAta, isSigner: false, isWritable: true },
          { pubkey: outputAta, isSigner: false, isWritable: true }
        ],
        data: Buffer.from([0])
      })
    ])
    expect(() => validateSwapTransaction(tx, solExpectations(fresh))).toThrow(
      /exactly 1 required signer/
    )
  })

  it("rejects a transaction whose fee payer is not the fresh address", () => {
    const fresh = Keypair.generate()
    const attacker = Keypair.generate()
    const wsolAta = associatedTokenAddress(fresh.publicKey, new PublicKey(WSOL_MINT))
    const outputAta = associatedTokenAddress(fresh.publicKey, USDC_MINT)
    // Built (and paid for) by the attacker, with the fresh key listed only as
    // a non-signer account: the single required signer is the attacker.
    const tx = buildTx(
      attacker,
      [
        new TransactionInstruction({
          programId: JUPITER,
          keys: [
            { pubkey: fresh.publicKey, isSigner: false, isWritable: true },
            { pubkey: wsolAta, isSigner: false, isWritable: true },
            { pubkey: outputAta, isSigner: false, isWritable: true }
          ],
          data: Buffer.from([0])
        })
      ]
    )
    expect(() => validateSwapTransaction(tx, solExpectations(fresh))).toThrow(
      /fee payer is not the fresh address/
    )
  })

  it("rejects an instruction to a non-allowlisted program", () => {
    const fresh = Keypair.generate()
    const wsolAta = associatedTokenAddress(fresh.publicKey, new PublicKey(WSOL_MINT))
    const outputAta = associatedTokenAddress(fresh.publicKey, USDC_MINT)
    const memo = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")
    const tx = buildTx(fresh, [
      new TransactionInstruction({
        programId: memo,
        keys: [{ pubkey: fresh.publicKey, isSigner: true, isWritable: false }],
        data: Buffer.from("drain me", "utf8")
      }),
      jupiterIx(fresh, wsolAta, outputAta)
    ])
    expect(() => validateSwapTransaction(tx, solExpectations(fresh))).toThrow(
      /non-allowlisted program/
    )
  })

  it("rejects a transaction with no Jupiter instruction", () => {
    const fresh = Keypair.generate()
    const wsolAta = associatedTokenAddress(fresh.publicKey, new PublicKey(WSOL_MINT))
    const tx = buildTx(fresh, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      SystemProgram.transfer({
        fromPubkey: fresh.publicKey,
        toPubkey: wsolAta,
        lamports: Number(INPUT_LAMPORTS)
      }),
      syncNativeIx(wsolAta)
    ])
    expect(() => validateSwapTransaction(tx, solExpectations(fresh))).toThrow(
      /no Jupiter aggregator instruction/
    )
  })

  it("accepts a token -> SOL swap shape (Jupiter + wSOL close)", () => {
    const fresh = Keypair.generate()
    const inputAta = associatedTokenAddress(fresh.publicKey, USDC_MINT)
    const wsolAta = associatedTokenAddress(fresh.publicKey, new PublicKey(WSOL_MINT))
    const tx = buildTx(fresh, [
      jupiterIx(fresh, inputAta, wsolAta),
      closeWsolIx(wsolAta, fresh)
    ])
    expect(() =>
      validateSwapTransaction(tx, {
        fresh: fresh.publicKey,
        inputMint: USDC_MINT.toBase58(),
        inputAmount: 500_000n,
        outputMint: "SOL",
        quotedOutAmount: 100_000
      })
    ).not.toThrow()
  })

  it("rejects closeAccount draining wSOL to another address", () => {
    const fresh = Keypair.generate()
    const attacker = Keypair.generate().publicKey
    const inputAta = associatedTokenAddress(fresh.publicKey, USDC_MINT)
    const wsolAta = associatedTokenAddress(fresh.publicKey, new PublicKey(WSOL_MINT))
    const tx = buildTx(fresh, [
      jupiterIx(fresh, inputAta, wsolAta),
      new TransactionInstruction({
        programId: TOKEN,
        keys: [
          { pubkey: wsolAta, isSigner: false, isWritable: true },
          { pubkey: attacker, isSigner: false, isWritable: true },
          { pubkey: fresh.publicKey, isSigner: true, isWritable: false }
        ],
        data: Buffer.from([9])
      })
    ])
    expect(() =>
      validateSwapTransaction(tx, {
        fresh: fresh.publicKey,
        inputMint: USDC_MINT.toBase58(),
        inputAmount: 500_000n,
        outputMint: "SOL",
        quotedOutAmount: 100_000
      })
    ).toThrow(/closeAccount destination is not the fresh address/)
  })
})

/** Fake SPL token account data: 165 bytes, amount u64 LE at offset 64. */
function tokenAccountData(amount: bigint): string {
  const buf = Buffer.alloc(165)
  buf.writeBigUInt64LE(amount, 64)
  return buf.toString("base64")
}

function stubConnection(simulatedOutAmount: bigint | null, err: unknown = null) {
  return {
    simulateTransaction: async () => ({
      value: {
        err,
        accounts:
          simulatedOutAmount === null
            ? [null]
            : [
                {
                  executable: false,
                  owner: TOKEN_PROGRAM_ID,
                  lamports: 2_039_280,
                  data: [tokenAccountData(simulatedOutAmount), "base64"],
                  rentEpoch: 0
                }
              ]
      }
    }),
    getAddressLookupTable: async () => ({ value: null })
  }
}

describe("verifySwapSimulation", () => {
  it("passes when the simulated output meets the quote minus slippage", async () => {
    const fresh = Keypair.generate()
    const minExpected =
      (BigInt(QUOTED_OUT) * 9_900n) / 10_000n
    await expect(
      verifySwapSimulation(
        stubConnection(minExpected) as never,
        validSolSwapTx(fresh),
        solExpectations(fresh)
      )
    ).resolves.toBeUndefined()
  })

  it("rejects when the simulated output is short (wrong mint / drain)", async () => {
    const fresh = Keypair.generate()
    await expect(
      verifySwapSimulation(
        stubConnection(1_000n) as never,
        validSolSwapTx(fresh),
        solExpectations(fresh)
      )
    ).rejects.toThrow(/below the quoted/)
  })

  it("rejects when simulation itself errors", async () => {
    const fresh = Keypair.generate()
    await expect(
      verifySwapSimulation(
        stubConnection(BigInt(QUOTED_OUT), "InstructionError") as never,
        validSolSwapTx(fresh),
        solExpectations(fresh)
      )
    ).rejects.toThrow(/simulation failed/)
  })
})

describe("validateAndSignSwapTransaction", () => {
  it("signs a valid swap and leaves a drain unsigned", async () => {
    const fresh = Keypair.generate()
    const good = validSolSwapTx(fresh)
    await validateAndSignSwapTransaction(
      stubConnection(BigInt(QUOTED_OUT)) as never,
      good,
      fresh,
      solExpectations(fresh)
    )
    expect(good.signatures[0]).not.toBeNull()

    const attacker = Keypair.generate().publicKey
    const wsolAta = associatedTokenAddress(fresh.publicKey, new PublicKey(WSOL_MINT))
    const outputAta = associatedTokenAddress(fresh.publicKey, USDC_MINT)
    const drain = buildTx(fresh, [
      SystemProgram.transfer({
        fromPubkey: fresh.publicKey,
        toPubkey: attacker,
        lamports: 5_000_000
      }),
      jupiterIx(fresh, wsolAta, outputAta)
    ])
    await expect(
      validateAndSignSwapTransaction(
        stubConnection(BigInt(QUOTED_OUT)) as never,
        drain,
        fresh,
        solExpectations(fresh)
      )
    ).rejects.toThrow(/wSOL account/)
    // Unsigned: the signature slot is still all zeroes.
    expect(drain.signatures[0]!.every((b) => b === 0)).toBe(true)
  })
})
