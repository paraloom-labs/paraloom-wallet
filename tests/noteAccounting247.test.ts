import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  v3NoteCommitment: vi.fn(async (amount: bigint, pubkeyHex: string, blindingHex: string) => {
    return `comm_${amount}_${pubkeyHex.slice(0, 8)}_${blindingHex.slice(0, 8)}`
  }),
  v3NoteCommitmentAsset: vi.fn(async () => "spl_comm"),
  v3NotePubkey: vi.fn(async (privkeyHex: string) => `pub_${privkeyHex.slice(0, 8)}`),
  v3MerklePath: vi.fn(async () => ({ path: ["00".repeat(32)], root: "root123" })),
  proveTransact: vi.fn(async () => ({ proof: "proof123" }))
}))

import {
  addDiscoveredNote,
  addNote,
  getNotes,
  markNoteSpentByCommitment,
  setNoteLeafIndex,
  type ShieldedNote
} from "../lib/paraloom/notes"
import { scanForNotes } from "../lib/paraloom/scan"
import { depositV3, spendV3, U64_MAX } from "../lib/paraloom/transactFlow"
import { installFakeChrome } from "./support/chromeStorage"
import { encryptNote } from "../lib/paraloom/noteCrypto"

const ACCOUNT = "paraloom1testaccount"
const PRIVKEY = "11".repeat(32)
const BOX_SECRET = Uint8Array.from(Buffer.from("22".repeat(32), "hex"))
// Matching box public key derived or dummy for testing
import * as nacl from "tweetnacl"
const BOX_KEYPAIR = nacl.box.keyPair.fromSecretKey(BOX_SECRET)
const BOX_PUB_HEX = Buffer.from(BOX_KEYPAIR.publicKey).toString("hex")

describe("scanForNotes dummy note filtering and lowercase normalization (#247)", () => {
  beforeEach(() => {
    installFakeChrome()
  })

  it("skips 0n-value filler ciphertexts and does not store them as unspent notes", async () => {
    const fillerCiphertext = encryptNote(BOX_PUB_HEX, {
      amount: 0n,
      blindingHex: "33".repeat(32),
      assetIdHex: "00".repeat(32)
    })

    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            output_commitment: "COMM_0_PUB_BLIND",
            ciphertext: fillerCiphertext,
            mint: null
          }
        ]
      })

      const found = await scanForNotes(ACCOUNT, BOX_KEYPAIR.secretKey, PRIVKEY)
      expect(found).toBe(0)
      const notes = await getNotes(ACCOUNT)
      expect(notes).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("addNote and addDiscoveredNote deduplication and normalization (#247)", () => {
  beforeEach(() => {
    installFakeChrome()
  })

  it("deduplicates case-insensitively when addNote races addDiscoveredNote", async () => {
    const commitment = "AABBCCDD".repeat(8)
    const discoveredNote: ShieldedNote = {
      amount: "5000000",
      blinding: "11".repeat(32),
      assetId: "00".repeat(32),
      signature: "",
      createdAt: 1000,
      spent: false,
      source: "transfer",
      commitment: commitment.toUpperCase()
    }

    // scanForNotes inserts the discovered note
    await addDiscoveredNote(ACCOUNT, discoveredNote)
    expect(await getNotes(ACCOUNT)).toHaveLength(1)

    // spendV3 settles and calls addNote with lowercase commitment and signature: ""
    const changeNote: ShieldedNote = {
      amount: "5000000",
      blinding: "11".repeat(32),
      assetId: "00".repeat(32),
      signature: "",
      createdAt: 1050,
      spent: false,
      source: "transfer",
      commitment: commitment.toLowerCase()
    }
    await addNote(ACCOUNT, changeNote)

    // Deduplication must prevent inserting a second copy
    const notes = await getNotes(ACCOUNT)
    expect(notes).toHaveLength(1)
    expect(notes[0].commitment).toBe(commitment.toLowerCase())
  })

  it("normalizes commitment in setNoteLeafIndex and markNoteSpentByCommitment", async () => {
    const commitment = "1234abcd".repeat(8)
    await addNote(ACCOUNT, {
      amount: "1000",
      blinding: "22".repeat(32),
      assetId: "00".repeat(32),
      signature: "sig1",
      createdAt: 1000,
      spent: false,
      commitment: commitment.toLowerCase()
    })

    // setNoteLeafIndex with uppercase commitment
    await setNoteLeafIndex(ACCOUNT, commitment.toUpperCase(), 42)
    let notes = await getNotes(ACCOUNT)
    expect(notes[0].leafIndex).toBe(42)

    // markNoteSpentByCommitment with uppercase commitment
    await markNoteSpentByCommitment(ACCOUNT, commitment.toUpperCase())
    notes = await getNotes(ACCOUNT)
    expect(notes[0].spent).toBe(true)
  })
})

describe("transactFlow depositV3 and spendV3 bounds and guards (#247)", () => {
  const dummyConnection = {} as any
  const dummyWallet = { secretKey: new Uint8Array(64) }

  it("depositV3 rejects non-positive or > u64::MAX lamports", async () => {
    await expect(depositV3(dummyConnection, dummyWallet, ACCOUNT, PRIVKEY, 0n)).rejects.toThrow(
      "deposit amount must be a positive u64"
    )
    await expect(depositV3(dummyConnection, dummyWallet, ACCOUNT, PRIVKEY, -100n)).rejects.toThrow(
      "deposit amount must be a positive u64"
    )
    await expect(
      depositV3(dummyConnection, dummyWallet, ACCOUNT, PRIVKEY, U64_MAX + 1n)
    ).rejects.toThrow("deposit amount must be a positive u64")
  })

  it("spendV3 rejects spent, zero-value, or duplicate input notes", async () => {
    const validNote1: ShieldedNote = {
      amount: "1000",
      blinding: "aa".repeat(32),
      assetId: "00".repeat(32),
      signature: "sig1",
      createdAt: 100,
      spent: false,
      commitment: "comm1".repeat(12).slice(0, 64)
    }
    const validNote2: ShieldedNote = {
      amount: "2000",
      blinding: "bb".repeat(32),
      assetId: "00".repeat(32),
      signature: "sig2",
      createdAt: 200,
      spent: false,
      commitment: "comm2".repeat(12).slice(0, 64)
    }

    // Rejects spent note
    const spentNote: ShieldedNote = { ...validNote1, spent: true }
    await expect(
      spendV3(dummyConnection, ACCOUNT, PRIVKEY, BOX_PUB_HEX, [spentNote], 500n, {
        kind: "withdraw",
        recipientSolanaHex: "00".repeat(32)
      })
    ).rejects.toThrow("cannot spend already spent note")

    // Rejects zero-value input note
    const zeroNote: ShieldedNote = { ...validNote1, amount: "0" }
    await expect(
      spendV3(dummyConnection, ACCOUNT, PRIVKEY, BOX_PUB_HEX, [zeroNote], 500n, {
        kind: "withdraw",
        recipientSolanaHex: "00".repeat(32)
      })
    ).rejects.toThrow("input note amount must be positive u64")

    // Rejects amount > u64::MAX
    const overflowNote: ShieldedNote = { ...validNote1, amount: (U64_MAX + 1n).toString() }
    await expect(
      spendV3(dummyConnection, ACCOUNT, PRIVKEY, BOX_PUB_HEX, [overflowNote], 500n, {
        kind: "withdraw",
        recipientSolanaHex: "00".repeat(32)
      })
    ).rejects.toThrow("input note amount must be positive u64")

    // Rejects duplicate input notes (same commitment)
    await expect(
      spendV3(
        dummyConnection,
        ACCOUNT,
        PRIVKEY,
        BOX_PUB_HEX,
        [validNote1, { ...validNote2, commitment: validNote1.commitment }],
        500n,
        { kind: "withdraw", recipientSolanaHex: "00".repeat(32) }
      )
    ).rejects.toThrow("duplicate input notes")

    // Rejects payLamports > U64_MAX
    await expect(
      spendV3(dummyConnection, ACCOUNT, PRIVKEY, BOX_PUB_HEX, [validNote1], U64_MAX + 1n, {
        kind: "withdraw",
        recipientSolanaHex: "00".repeat(32)
      })
    ).rejects.toThrow("amount exceeds the selected notes")
  })
})
