import { Keypair, type Connection } from "@solana/web3.js"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getNotes } from "~lib/paraloom/notes"
import { installFakeChrome } from "./support/chromeStorage"

const MOCK_PUBKEY = "11".repeat(32)
const MOCK_COMMITMENT = "22".repeat(32)

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  v3NotePubkey: vi.fn(async () => MOCK_PUBKEY),
  v3NoteCommitment: vi.fn(async () => MOCK_COMMITMENT)
}))

const mockConfirmBySignatureStatus = vi.fn()
vi.mock("~lib/paraloom/bridge", () => ({
  confirmBySignatureStatus: (...args: unknown[]) => mockConfirmBySignatureStatus(...args)
}))

import { sendDepositNote } from "~lib/paraloom/transact"
import { depositV3 } from "~lib/paraloom/transactFlow"

describe("sendDepositNote and depositV3 (#181)", () => {
  const payer = Keypair.generate()
  const shieldedAddress = "paraloom1" + "aa".repeat(64)
  const spendPrivkeyHex = "33".repeat(32)
  const amountLamports = 1_000_000_000n

  function createMockConnection(options: {
    sendRawTransaction?: () => Promise<string>
    getTransaction?: () => Promise<{ meta: { logMessages: string[] } } | null>
  } = {}) {
    return {
      getLatestBlockhash: vi.fn(async () => ({
        blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
        lastValidBlockHeight: 100
      })),
      sendRawTransaction: options.sendRawTransaction ?? vi.fn(async () => "sig-test-deposit-123"),
      getTransaction: options.getTransaction ?? vi.fn(async () => ({
        meta: {
          logMessages: [
            "Program 11111111111111111111111111111111 invoke [1]",
            "Program log: Deposit note appended at leaf 42",
            "Program 11111111111111111111111111111111 success"
          ]
        }
      }))
    } as unknown as Connection
  }

  beforeEach(() => {
    installFakeChrome()
    vi.clearAllMocks()
  })

  describe("sendDepositNote", () => {
    it("returns signature when confirmBySignatureStatus returns true", async () => {
      mockConfirmBySignatureStatus.mockResolvedValueOnce(true)
      const connection = createMockConnection()

      const sig = await sendDepositNote(
        connection,
        payer,
        amountLamports,
        new Uint8Array(32),
        new Uint8Array(32)
      )

      expect(sig).toBe("sig-test-deposit-123")
      expect(mockConfirmBySignatureStatus).toHaveBeenCalledWith(connection, "sig-test-deposit-123")
    })

    it("throws timeout error when confirmBySignatureStatus returns false", async () => {
      mockConfirmBySignatureStatus.mockResolvedValueOnce(false)
      const connection = createMockConnection()

      await expect(
        sendDepositNote(
          connection,
          payer,
          amountLamports,
          new Uint8Array(32),
          new Uint8Array(32)
        )
      ).rejects.toThrow("deposit transaction sig-test-deposit-123 was not confirmed within timeout")
    })

    it("propagates error when confirmBySignatureStatus rejects with on-chain failure", async () => {
      mockConfirmBySignatureStatus.mockRejectedValueOnce(
        new Error('transaction failed on-chain: {"InstructionError":[0,"Custom(1)"]}')
      )
      const connection = createMockConnection()

      await expect(
        sendDepositNote(
          connection,
          payer,
          amountLamports,
          new Uint8Array(32),
          new Uint8Array(32)
        )
      ).rejects.toThrow('transaction failed on-chain: {"InstructionError":[0,"Custom(1)"]}')
    })

    it("invokes onSubmitted callback with signature before awaiting confirmation", async () => {
      mockConfirmBySignatureStatus.mockResolvedValueOnce(true)
      const connection = createMockConnection()
      let submittedSig = ""

      await sendDepositNote(
        connection,
        payer,
        amountLamports,
        new Uint8Array(32),
        new Uint8Array(32),
        async (sig) => {
          submittedSig = sig
        }
      )

      expect(submittedSig).toBe("sig-test-deposit-123")
    })
  })

  describe("depositV3", () => {
    it("successfully creates note, confirms transaction, and sets leaf index", async () => {
      mockConfirmBySignatureStatus.mockResolvedValueOnce(true)
      const connection = createMockConnection()

      const res = await depositV3(
        connection,
        payer,
        shieldedAddress,
        spendPrivkeyHex,
        amountLamports
      )

      expect(res.signature).toBe("sig-test-deposit-123")
      expect(res.leafIndex).toBe(42)

      const notes = await getNotes(shieldedAddress)
      expect(notes).toHaveLength(1)
      expect(notes[0].spent).toBe(false)
      expect(notes[0].commitment).toBe(MOCK_COMMITMENT)
      expect(notes[0].leafIndex).toBe(42)
      expect(notes[0].amount).toBe(amountLamports.toString())
      expect(notes[0].source).toBe("deposit")
    })

    it("rolls back optimistic note by marking it spent on on-chain failure", async () => {
      mockConfirmBySignatureStatus.mockRejectedValueOnce(
        new Error('transaction failed on-chain: {"InstructionError":[0,"Custom(6001)"]}')
      )
      const connection = createMockConnection()

      await expect(
        depositV3(connection, payer, shieldedAddress, spendPrivkeyHex, amountLamports)
      ).rejects.toThrow('transaction failed on-chain: {"InstructionError":[0,"Custom(6001)"]}')

      const notes = await getNotes(shieldedAddress)
      expect(notes).toHaveLength(1)
      expect(notes[0].commitment).toBe(MOCK_COMMITMENT)
      expect(notes[0].spent).toBe(true)
    })

    it("does not mark optimistic note spent when transaction times out", async () => {
      mockConfirmBySignatureStatus.mockResolvedValueOnce(false)
      const connection = createMockConnection()

      await expect(
        depositV3(connection, payer, shieldedAddress, spendPrivkeyHex, amountLamports)
      ).rejects.toThrow("deposit transaction sig-test-deposit-123 was not confirmed within timeout")

      const notes = await getNotes(shieldedAddress)
      expect(notes).toHaveLength(1)
      expect(notes[0].commitment).toBe(MOCK_COMMITMENT)
      expect(notes[0].spent).toBe(false)
    })

    it("does not create note if sendRawTransaction fails before onSubmitted", async () => {
      const connection = createMockConnection({
        sendRawTransaction: vi.fn(async () => {
          throw new Error("RPC node unreachable")
        })
      })

      await expect(
        depositV3(connection, payer, shieldedAddress, spendPrivkeyHex, amountLamports)
      ).rejects.toThrow("RPC node unreachable")

      const notes = await getNotes(shieldedAddress)
      expect(notes).toHaveLength(0)
    })
  })
})
