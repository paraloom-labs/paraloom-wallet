import { describe, expect, it, vi } from "vitest"
import { transfer } from "~lib/paraloom/transfer"
import { withdraw } from "~lib/paraloom/withdraw"
import { proveTransferV2, proveTransact } from "~lib/prover"
import type { ShieldedNote } from "~lib/paraloom/notes"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  noteCommitmentV2: vi.fn().mockResolvedValue("01".repeat(32)),
  proveTransferV2: vi.fn().mockImplementation(async (root, assetIdHex, inputs, outputs) => {
    const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
    for (const i of inputs) {
      if (BigInt(i.amount) > MAX_SAFE) {
        throw new Error(
          `Transfer input note amount (${i.amount.toString()}) exceeds JavaScript safe integer limit (${Number.MAX_SAFE_INTEGER}); precision loss in prover interface`
        )
      }
    }
    for (const o of outputs) {
      if (BigInt(o.amount) > MAX_SAFE) {
        throw new Error(
          `Transfer output note amount (${o.amount.toString()}) exceeds JavaScript safe integer limit (${Number.MAX_SAFE_INTEGER}); precision loss in prover interface`
        )
      }
    }
    return {
      nullifiers: ["11".repeat(32), "22".repeat(32)],
      output_commitments: ["33".repeat(32), "44".repeat(32)],
      proof: "ff".repeat(64)
    }
  }),
  proveTransact: vi.fn().mockImplementation(async (root, extAmount, recipientHex, assetIdHex, inputs, outputs) => {
    const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
    for (const i of inputs) {
      if (BigInt(i.amount) > MAX_SAFE) {
        throw new Error(
          `Transact input note amount (${i.amount.toString()}) exceeds JavaScript safe integer limit (${Number.MAX_SAFE_INTEGER}); precision loss in prover interface`
        )
      }
    }
    for (const o of outputs) {
      if (BigInt(o.amount) > MAX_SAFE) {
        throw new Error(
          `Transact output note amount (${o.amount.toString()}) exceeds JavaScript safe integer limit (${Number.MAX_SAFE_INTEGER}); precision loss in prover interface`
        )
      }
    }
    return JSON.stringify({ nullifiers: [], output_commitments: [], proof: "" })
  }),
  proveWithdrawalV2: vi.fn().mockResolvedValue({
    nullifier: "00".repeat(32),
    proof: "aa".repeat(64)
  })
}))

vi.mock("~lib/crypto/keyManagement", () => ({
  addressBoxPubHex: vi.fn().mockReturnValue("aa".repeat(32)),
  addressSpendPubHex: vi.fn().mockReturnValue("bb".repeat(32)),
  solanaAddressToBytes: vi.fn().mockReturnValue(new Uint8Array(32))
}))

vi.mock("~lib/paraloom/noteCrypto", () => ({
  encryptNote: vi.fn().mockReturnValue("encrypted-note-payload")
}))

vi.mock("~lib/paraloom/notes", () => ({
  addDiscoveredNote: vi.fn().mockResolvedValue(undefined),
  markNoteSpent: vi.fn().mockResolvedValue(undefined),
  markNoteSpentByCommitment: vi.fn().mockResolvedValue(undefined)
}))

const mockNote = (amount: string, index = 0): ShieldedNote => ({
  amount,
  blinding: "11".repeat(32),
  assetId: "00".repeat(32),
  signature: `sig-${index}`,
  createdAt: Date.now(),
  spent: false,
  source: "deposit"
})

describe("Safe integer bounds and IEEE-754 precision loss protection", () => {
  it("rejects transfer when an input note amount exceeds MAX_SAFE_INTEGER", async () => {
    const oversizedAmount = (BigInt(Number.MAX_SAFE_INTEGER) + 100n).toString()
    const inputs: [ShieldedNote, ShieldedNote] = [
      mockNote(oversizedAmount, 1),
      mockNote("1000", 2)
    ]

    await expect(
      transfer(
        "acc-1",
        "shielded-own-address",
        "shielded-recipient-address",
        1000n,
        inputs,
        "spend-privkey-hex"
      )
    ).rejects.toThrow("exceeds JavaScript safe integer limit")
  })

  it("rejects transfer when transfer amount exceeds MAX_SAFE_INTEGER", async () => {
    const normalInput1 = (BigInt(Number.MAX_SAFE_INTEGER) / 2n).toString()
    const normalInput2 = (BigInt(Number.MAX_SAFE_INTEGER) / 2n + 1000n).toString()
    const inputs: [ShieldedNote, ShieldedNote] = [
      mockNote(normalInput1, 1),
      mockNote(normalInput2, 2)
    ]
    const oversizedTransferAmount = BigInt(Number.MAX_SAFE_INTEGER) + 500n

    await expect(
      transfer(
        "acc-1",
        "shielded-own-address",
        "shielded-recipient-address",
        oversizedTransferAmount,
        inputs,
        "spend-privkey-hex"
      )
    ).rejects.toThrow("Transfer amount")
  })

  it("rejects transfer when change amount exceeds MAX_SAFE_INTEGER", async () => {
    const safeMax = BigInt(Number.MAX_SAFE_INTEGER)
    const inputs: [ShieldedNote, ShieldedNote] = [
      mockNote(safeMax.toString(), 1),
      mockNote(safeMax.toString(), 2)
    ]

    await expect(
      transfer(
        "acc-1",
        "shielded-own-address",
        "shielded-recipient-address",
        100n,
        inputs,
        "spend-privkey-hex"
      )
    ).rejects.toThrow("Change amount")
  })

  it("rejects withdrawal when amount exceeds MAX_SAFE_INTEGER", async () => {
    const oversizedAmount = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString()
    const note = mockNote(oversizedAmount)

    await expect(
      withdraw(note, "11111111111111111111111111111111", "spend-privkey-hex")
    ).rejects.toThrow("Withdrawal amount")
  })

  it("rejects proveTransferV2 when input or output note exceeds MAX_SAFE_INTEGER", async () => {
    const oversized = BigInt(Number.MAX_SAFE_INTEGER) + 10n
    const valid = BigInt(Number.MAX_SAFE_INTEGER)

    await expect(
      proveTransferV2(
        "root",
        "asset",
        [{ amount: oversized, blinding_hex: "", privkey_hex: "", path_hex: [], indices: [] }],
        [{ amount: valid, blinding_hex: "", pubkey_hex: "" }]
      )
    ).rejects.toThrow("exceeds JavaScript safe integer limit")

    await expect(
      proveTransferV2(
        "root",
        "asset",
        [{ amount: valid, blinding_hex: "", privkey_hex: "", path_hex: [], indices: [] }],
        [{ amount: oversized, blinding_hex: "", pubkey_hex: "" }]
      )
    ).rejects.toThrow("exceeds JavaScript safe integer limit")
  })

  it("rejects proveTransact when input or output note exceeds MAX_SAFE_INTEGER", async () => {
    const oversized = BigInt(Number.MAX_SAFE_INTEGER) + 50n
    const normal = 1000n

    await expect(
      proveTransact(
        "root",
        0n,
        "recipient",
        "asset",
        [
          { amount: oversized, privkeyHex: "", blindingHex: "", leafIndex: 0, pathHex: [] },
          { amount: normal, privkeyHex: "", blindingHex: "", leafIndex: 1, pathHex: [] }
        ],
        [
          { amount: normal, pubkeyHex: "", blindingHex: "" },
          { amount: normal, pubkeyHex: "", blindingHex: "" }
        ]
      )
    ).rejects.toThrow("exceeds JavaScript safe integer limit")
  })
})
