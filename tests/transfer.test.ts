import { beforeEach, describe, expect, it, vi } from "vitest"

import { installFakeChrome } from "./support/chromeStorage"

// Mock the prover module
const { mockProveTransferV2, mockNoteCommitmentV2 } = vi.hoisted(() => ({
  mockProveTransferV2: vi.fn(
    async (
      _root: string,
      _assetIdHex: string,
      _inputs: any[],
      _outputs: any[]
    ) => ({
      nullifiers: ["nullifier1", "nullifier2"],
      output_commitments: ["out_comm_0", "out_comm_1"],
      proof: "proof_hex_test"
    })
  ),
  mockNoteCommitmentV2: vi.fn(async () => "comm_test_123")
}))

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  noteCommitmentV2: mockNoteCommitmentV2,
  proveTransferV2: mockProveTransferV2
}))

// Mock keyManagement helpers
vi.mock("~lib/crypto/keyManagement", () => ({
  addressSpendPubHex: vi.fn(() => "spend_pub_hex"),
  addressBoxPubHex: vi.fn(() => "box_pub_hex")
}))

// Mock noteCrypto
vi.mock("../lib/paraloom/noteCrypto", () => ({
  encryptNote: vi.fn(() => "encrypted_note_ciphertext")
}))

import { transfer } from "../lib/paraloom/transfer"
import { getNotes, type ShieldedNote } from "../lib/paraloom/notes"

const ACCOUNT = "paraloom1" + "11".repeat(64)
const RECIPIENT = "paraloom1" + "22".repeat(64)

function sampleNote(overrides: Partial<ShieldedNote> = {}): ShieldedNote {
  return {
    amount: "1000",
    blinding: "aa".repeat(32),
    assetId: "00".repeat(32),
    signature: "sig-deposit-1",
    createdAt: 1,
    spent: false,
    source: "deposit",
    ...overrides
  }
}

describe("transfer safe integer precision (#118)", () => {
  beforeEach(() => {
    installFakeChrome()
    vi.restoreAllMocks()
    mockProveTransferV2.mockClear()
    mockNoteCommitmentV2.mockClear()
  })

  it("passes bigint amounts to proveTransferV2 without Number truncation", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = String(url)
      if (urlStr.includes("/merkle/path/")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            root: "root_generation_A",
            path: ["01".repeat(32)],
            indices: [false]
          })
        } as unknown as Response
      }
      if (urlStr.includes("/transfer/submit")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ request_id: "req_test_123" })
        } as unknown as Response
      }
      return { status: 404, ok: false } as unknown as Response
    })

    const note1 = sampleNote({ signature: "sig-1", amount: "500" })
    const note2 = sampleNote({ signature: "sig-2", amount: "500" })

    const result = await transfer(
      ACCOUNT,
      ACCOUNT,
      RECIPIENT,
      600n,
      [note1, note2],
      "privkey_hex"
    )

    expect(result.requestId).toBe("req_test_123")
    expect(result.changeCommitment).toBe("out_comm_1")
    expect(mockProveTransferV2).toHaveBeenCalledOnce()

    const callArgs = mockProveTransferV2.mock.calls[0]
    const passedInputs = callArgs[2]
    const passedOutputs = callArgs[3]

    // Verify proofInputs keep bigint amounts
    expect(typeof passedInputs[0].amount).toBe("bigint")
    expect(passedInputs[0].amount).toBe(500n)
    expect(typeof passedInputs[1].amount).toBe("bigint")
    expect(passedInputs[1].amount).toBe(500n)

    // Verify outputs keep bigint amounts
    expect(typeof passedOutputs[0].amount).toBe("bigint")
    expect(passedOutputs[0].amount).toBe(600n)
    expect(typeof passedOutputs[1].amount).toBe("bigint")
    expect(passedOutputs[1].amount).toBe(400n)
  })

  it("throws when transfer amount exceeds MAX_SAFE_INTEGER", async () => {
    const hugeAmount = BigInt(Number.MAX_SAFE_INTEGER) + 2n
    const note1 = sampleNote({ signature: "sig-1", amount: hugeAmount.toString() })
    const note2 = sampleNote({ signature: "sig-2", amount: "100" })

    await expect(
      transfer(
        ACCOUNT,
        ACCOUNT,
        RECIPIENT,
        hugeAmount,
        [note1, note2],
        "privkey_hex"
      )
    ).rejects.toThrow("Amount exceeds JavaScript safe integer limit; must use 64-bit bigint prover interface")
  })

  it("throws when change amount exceeds MAX_SAFE_INTEGER", async () => {
    const hugeAmount = BigInt(Number.MAX_SAFE_INTEGER) + 100n
    const note1 = sampleNote({ signature: "sig-1", amount: hugeAmount.toString() })
    const note2 = sampleNote({ signature: "sig-2", amount: "100" })

    await expect(
      transfer(
        ACCOUNT,
        ACCOUNT,
        RECIPIENT,
        10n,
        [note1, note2],
        "privkey_hex"
      )
    ).rejects.toThrow("Amount exceeds JavaScript safe integer limit; must use 64-bit bigint prover interface")
  })

  it("throws when an input note amount exceeds MAX_SAFE_INTEGER", async () => {
    const hugeInput = BigInt(Number.MAX_SAFE_INTEGER) + 500n
    const note1 = sampleNote({ signature: "sig-1", amount: hugeInput.toString() })
    const note2 = sampleNote({ signature: "sig-2", amount: "50" })

    await expect(
      transfer(
        ACCOUNT,
        ACCOUNT,
        RECIPIENT,
        100n,
        [note1, note2],
        "privkey_hex"
      )
    ).rejects.toThrow("Amount exceeds JavaScript safe integer limit; must use 64-bit bigint prover interface")
  })
})
