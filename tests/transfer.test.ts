import { beforeEach, describe, expect, it, vi } from "vitest"

import { installFakeChrome } from "./support/chromeStorage"

// Mock the prover module because the wasm binary cannot load under vitest node environment
vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  noteCommitmentV2: vi.fn(async () => "comm_test_123"),
  proveTransferV2: vi.fn(async () => ({
    nullifiers: ["nullifier1", "nullifier2"],
    output_commitments: ["out_comm_0", "out_comm_1"],
    proof: { a: [], b: [], c: [] }
  }))
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

describe("transfer witness assembly and root synchronization (#128)", () => {
  beforeEach(() => {
    installFakeChrome()
    vi.restoreAllMocks()
  })

  it("throws error when input Merkle roots diverge due to concurrent tree updates", async () => {
    let callCount = 0
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = String(url)
      if (urlStr.includes("/merkle/path/")) {
        callCount++
        return {
          status: 200,
          ok: true,
          json: async () => ({
            root: callCount === 1 ? "root_generation_A" : "root_generation_B",
            path: ["01".repeat(32)],
            indices: [false]
          })
        } as unknown as Response
      }
      return { status: 404, ok: false } as unknown as Response
    })

    const note1 = sampleNote({ signature: "sig-1", amount: "500" })
    const note2 = sampleNote({ signature: "sig-2", amount: "500" })

    await expect(
      transfer(
        ACCOUNT,
        ACCOUNT,
        RECIPIENT,
        600n,
        [note1, note2],
        "privkey_hex"
      )
    ).rejects.toThrow("Merkle tree updated during witness assembly; retry to synchronize roots")
  })

  it("does not mutate local notes if settlement confirmation fails", async () => {
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

    // Seed storage with note1 and note2
    const { addNote } = await import("../lib/paraloom/notes")
    await addNote(ACCOUNT, note1)
    await addNote(ACCOUNT, note2)

    const result = await transfer(
      ACCOUNT,
      ACCOUNT,
      RECIPIENT,
      600n,
      [note1, note2],
      "privkey_hex",
      undefined,
      async () => false // Settlement fails / unconfirmed
    )

    expect(result.requestId).toBe("req_test_123")
    expect(result.settled).toBe(false)

    // Notes must still be unspent
    const storedNotes = await getNotes(ACCOUNT)
    expect(storedNotes.filter((n) => !n.spent)).toHaveLength(2)
    // No change note added
    expect(storedNotes.some((n) => n.commitment === "out_comm_1")).toBe(false)
  })

  it("marks notes spent and creates change note when settlement is confirmed", async () => {
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

    const { addNote } = await import("../lib/paraloom/notes")
    await addNote(ACCOUNT, note1)
    await addNote(ACCOUNT, note2)

    const result = await transfer(
      ACCOUNT,
      ACCOUNT,
      RECIPIENT,
      600n,
      [note1, note2],
      "privkey_hex",
      undefined,
      async () => true // Settlement succeeds
    )

    expect(result.requestId).toBe("req_test_123")
    expect(result.settled).toBe(true)

    // Inputs marked spent
    const storedNotes = await getNotes(ACCOUNT)
    const spentInputs = storedNotes.filter((n) => n.spent)
    expect(spentInputs).toHaveLength(2)

    // Change note recorded
    const changeNote = storedNotes.find((n) => n.commitment === "out_comm_1")
    expect(changeNote).toBeDefined()
    expect(changeNote?.amount).toBe("400")
    expect(changeNote?.spent).toBe(false)
  })
})
