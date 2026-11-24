// Tests for the swap-transaction validation module (#300).
//
// These tests verify that validateSwapTransaction correctly rejects
// malicious/invalid router responses and accepts legitimate ones.
// The tests use mock Solana transactions to simulate various attack vectors.

import { describe, expect, it, vi } from "vitest"
import {
  Keypair,
  MessageV0,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js"

import {
  ALLOWED_PROGRAMS,
  SwapValidationError,
  validateSwapTransaction
} from "~lib/paraloom/validateSwapTransaction"

// ── Helpers ─────────────────────────────────────────────────────────────

/** Jupiter v6 program ID */
const JUPITER_V6 = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")

/** Build a minimal VersionedTransaction with the given instructions and signer. */
function buildVersionedTx(
  payer: Keypair,
  instructions: TransactionInstruction[],
  recentBlockhash = "11111111111111111111111111111111"
): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash,
    instructions
  }).compileToV0Message()

  return new VersionedTransaction(message)
}

/** Build a fake Jupiter swap instruction (noop data, correct program ID). */
function fakeJupiterSwapIx(fresh: Keypair): TransactionInstruction {
  return new TransactionInstruction({
    programId: JUPITER_V6,
    keys: [
      { pubkey: fresh.publicKey, isSigner: true, isWritable: true }
    ],
    data: Buffer.alloc(8) // placeholder instruction data
  })
}

/** Build a ComputeBudget SetComputeUnitLimit instruction. */
function computeBudgetIx(): TransactionInstruction {
  const COMPUTE_BUDGET = new PublicKey("ComputeBudget111111111111111111111111111111")
  return new TransactionInstruction({
    programId: COMPUTE_BUDGET,
    keys: [],
    // SetComputeUnitLimit discriminator (0x02) + 200000 units
    data: Buffer.from([0x02, 0x40, 0x0d, 0x03, 0x00])
  })
}

/** Create a mock Connection with simulateTransaction and getAddressLookupTable. */
function mockConnection(opts?: {
  simErr?: unknown
  simAccounts?: Array<{ lamports: number } | null>
}) {
  return {
    simulateTransaction: vi.fn().mockResolvedValue({
      value: {
        err: opts?.simErr ?? null,
        accounts: opts?.simAccounts ?? [{ lamports: 500_000_000 }],
        logs: []
      }
    }),
    getAddressLookupTable: vi.fn().mockResolvedValue({ value: null })
  } as unknown as import("@solana/web3.js").Connection
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("validateSwapTransaction", () => {
  describe("signer checks", () => {
    it("accepts a tx where only the fresh key is a signer", async () => {
      const fresh = Keypair.generate()
      const tx = buildVersionedTx(fresh, [
        computeBudgetIx(),
        fakeJupiterSwapIx(fresh)
      ])
      const conn = mockConnection()

      await expect(
        validateSwapTransaction({
          tx,
          fresh,
          connection: conn,
          quotedOutAmount: 1_000_000,
          outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          inputAmount: 1_000_000_000n
        })
      ).resolves.toBeUndefined()
    })

    it("rejects a tx requiring a second signer (attacker key)", async () => {
      const fresh = Keypair.generate()
      const attacker = Keypair.generate()

      // Build a message that requires both fresh and attacker as signers.
      // We use a SystemProgram transfer FROM the attacker — but the real
      // attack is the reverse: the attacker key is added as a signer to
      // authorize a drain.
      const ix = SystemProgram.transfer({
        fromPubkey: attacker.publicKey,
        toPubkey: fresh.publicKey,
        lamports: 1
      })
      // This creates a message where attacker is also a required signer
      const message = new TransactionMessage({
        payerKey: fresh.publicKey,
        recentBlockhash: "11111111111111111111111111111111",
        instructions: [ix]
      }).compileToV0Message()

      const tx = new VersionedTransaction(message)
      const conn = mockConnection()

      // The tx should have 2 required signers (fresh + attacker), and
      // validation should reject it because signer[1] != fresh
      if (message.header.numRequiredSignatures > 1) {
        await expect(
          validateSwapTransaction({
            tx,
            fresh,
            connection: conn,
            quotedOutAmount: 1_000_000,
            outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            inputAmount: 1_000_000_000n
          })
        ).rejects.toThrow(SwapValidationError)
      }
    })
  })

  describe("program allowlist", () => {
    it("rejects a tx with an instruction to an unknown program", async () => {
      const fresh = Keypair.generate()
      const maliciousProgram = Keypair.generate().publicKey

      const maliciousIx = new TransactionInstruction({
        programId: maliciousProgram,
        keys: [{ pubkey: fresh.publicKey, isSigner: true, isWritable: true }],
        data: Buffer.alloc(8)
      })

      const tx = buildVersionedTx(fresh, [maliciousIx])
      const conn = mockConnection()

      await expect(
        validateSwapTransaction({
          tx,
          fresh,
          connection: conn,
          quotedOutAmount: 1_000_000,
          outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          inputAmount: 1_000_000_000n
        })
      ).rejects.toThrow(/unknown program/)
    })

    it("accepts a tx with only allowed programs (Jupiter + ComputeBudget + System)", async () => {
      const fresh = Keypair.generate()
      const tx = buildVersionedTx(fresh, [
        computeBudgetIx(),
        fakeJupiterSwapIx(fresh)
      ])
      const conn = mockConnection()

      await expect(
        validateSwapTransaction({
          tx,
          fresh,
          connection: conn,
          quotedOutAmount: 1_000_000,
          outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          inputAmount: 1_000_000_000n
        })
      ).resolves.toBeUndefined()
    })

    it("rejects a SystemProgram.transfer to an attacker (when mixed with unknown program)", async () => {
      const fresh = Keypair.generate()
      const attackerAccount = Keypair.generate().publicKey
      const maliciousProgram = Keypair.generate().publicKey

      // A drain tx: SystemProgram.transfer to attacker + unknown program
      const drain = SystemProgram.transfer({
        fromPubkey: fresh.publicKey,
        toPubkey: attackerAccount,
        lamports: 1_000_000_000
      })
      const unknownIx = new TransactionInstruction({
        programId: maliciousProgram,
        keys: [{ pubkey: fresh.publicKey, isSigner: true, isWritable: true }],
        data: Buffer.alloc(8)
      })

      const tx = buildVersionedTx(fresh, [drain, unknownIx])
      const conn = mockConnection()

      await expect(
        validateSwapTransaction({
          tx,
          fresh,
          connection: conn,
          quotedOutAmount: 1_000_000,
          outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          inputAmount: 1_000_000_000n
        })
      ).rejects.toThrow(/unknown program/)
    })
  })

  describe("simulation checks", () => {
    it("rejects a tx whose simulation fails with an error", async () => {
      const fresh = Keypair.generate()
      const tx = buildVersionedTx(fresh, [
        computeBudgetIx(),
        fakeJupiterSwapIx(fresh)
      ])
      const conn = mockConnection({
        simErr: { InstructionError: [0, "Custom"] }
      })

      await expect(
        validateSwapTransaction({
          tx,
          fresh,
          connection: conn,
          quotedOutAmount: 1_000_000,
          outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          inputAmount: 1_000_000_000n
        })
      ).rejects.toThrow(/simulation failed/)
    })

    it("rejects a SOL-output tx where simulation shows fresh balance dropped to 0", async () => {
      const fresh = Keypair.generate()
      const tx = buildVersionedTx(fresh, [
        computeBudgetIx(),
        fakeJupiterSwapIx(fresh)
      ])
      const conn = mockConnection({
        simAccounts: [{ lamports: 0 }]
      })

      await expect(
        validateSwapTransaction({
          tx,
          fresh,
          connection: conn,
          quotedOutAmount: 1_000_000,
          outputMint: "SOL",
          inputAmount: 1_000_000_000n
        })
      ).rejects.toThrow(/balance dropped to 0/)
    })
  })

  describe("allowed programs set", () => {
    it("contains Jupiter v6", () => {
      expect(ALLOWED_PROGRAMS.has("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")).toBe(true)
    })

    it("contains System Program", () => {
      expect(ALLOWED_PROGRAMS.has("11111111111111111111111111111111")).toBe(true)
    })

    it("contains Token Program", () => {
      expect(ALLOWED_PROGRAMS.has("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")).toBe(true)
    })

    it("contains ComputeBudget", () => {
      expect(ALLOWED_PROGRAMS.has("ComputeBudget111111111111111111111111111111")).toBe(true)
    })

    it("contains Raydium AMM v4", () => {
      expect(ALLOWED_PROGRAMS.has("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8")).toBe(true)
    })

    it("contains Orca Whirlpool", () => {
      expect(ALLOWED_PROGRAMS.has("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc")).toBe(true)
    })

    it("does not contain random program IDs", () => {
      expect(ALLOWED_PROGRAMS.has("SomeRandomProgramId111111111111111111111111")).toBe(false)
    })
  })

  describe("edge cases", () => {
    it("handles WSOL mint as SOL output", async () => {
      const fresh = Keypair.generate()
      const tx = buildVersionedTx(fresh, [
        computeBudgetIx(),
        fakeJupiterSwapIx(fresh)
      ])
      // Simulation shows non-zero balance — should pass
      const conn = mockConnection({
        simAccounts: [{ lamports: 500_000_000 }]
      })

      await expect(
        validateSwapTransaction({
          tx,
          fresh,
          connection: conn,
          quotedOutAmount: 1_000_000,
          outputMint: "So11111111111111111111111111111111111111112",
          inputAmount: 1_000_000_000n
        })
      ).resolves.toBeUndefined()
    })

    it("passes custom slippageBps through without error", async () => {
      const fresh = Keypair.generate()
      const tx = buildVersionedTx(fresh, [
        computeBudgetIx(),
        fakeJupiterSwapIx(fresh)
      ])
      const conn = mockConnection()

      await expect(
        validateSwapTransaction({
          tx,
          fresh,
          connection: conn,
          quotedOutAmount: 1_000_000,
          outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          inputAmount: 1_000_000_000n,
          slippageBps: 300
        })
      ).resolves.toBeUndefined()
    })
  })
})
