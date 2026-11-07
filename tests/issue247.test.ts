import { Connection, Keypair } from "@solana/web3.js"
import { encryptNote } from "~lib/paraloom/noteCrypto"
import { addNote, getNotes, shieldedBalance, type ShieldedNote } from "~lib/paraloom/notes"
import { scanForNotes } from "~lib/paraloom/scan"
import { depositV3, MAX_U64, spendV3 } from "~lib/paraloom/transactFlow"
import * as nacl from "tweetnacl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { installFakeChrome } from "./support/chromeStorage"

const fakeCommitment = (amount: bigint, pubkeyHex: string, blindingHex: string) =>
  `c${amount.toString(16)}_${pubkeyHex.slice(0, 8)}_${blindingHex.slice(0, 8)}`

vi.mock("~lib/prover", () => ({
  v3NoteCommitment: vi.fn(async (a: bigint, p: string, b: string) => fakeCommitment(a, p, b)),
  v3NoteCommitmentAsset: vi.fn(
    async (a: bigint, p: string, b: string, s: string) =>
      `${fakeCommitment(a, p, b)}@${s.slice(0, 8)}`
  ),
  v3NotePubkey: vi.fn(async (privkeyHex: string) => `pub_${privkeyHex}`),
  v3MerklePath: vi.fn(async () => ({ path: ["00".repeat(32)], root: "root_hex" })),
  proveTransact: vi.fn(async () => ({
    proof: "mock_proof",
    nullifiers: ["n1", "n2"],
    commitments: ["c1", "c2"]
  })),
  assetIdForMint: vi.fn(async () => "00".repeat(32)),
  NATIVE_ASSET_HEX: "00".repeat(32)
}))

const ACCOUNT = "paraloom1" + "11".repeat(64)
const SPEND_PRIVKEY = "ab".repeat(32)
const OUR_SPEND_PUB = `pub_${SPEND_PRIVKEY}`
const BLINDING = "cc".repeat(32)
const ASSET = "00".repeat(32)

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex")

let ourBox: nacl.BoxKeyPair

function honest(amount: bigint, blindingHex = BLINDING) {
  return {
    output_commitment: fakeCommitment(amount, OUR_SPEND_PUB, blindingHex),
    ciphertext: encryptNote(hex(ourBox.publicKey), {
      amount,
      blindingHex,
      assetIdHex: ASSET
    })
  }
}

function respondWith(delivered: unknown[]) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => delivered
  }))
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

beforeEach(() => {
  installFakeChrome()
  ourBox = nacl.box.keyPair()
  vi.clearAllMocks()
})

describe("scanForNotes drops 0-value filler ciphertexts", () => {
  it("drops 0-value filler ciphertext and does not store it as an unspent note", async () => {
    // Deliver a 0-value filler note (e.g. from withdraw padding)
    const filler = honest(0n, "ff".repeat(32))
    respondWith([filler])

    const found = await scanForNotes(ACCOUNT, ourBox.secretKey, SPEND_PRIVKEY)
    expect(found).toBe(0)

    const notes = await getNotes(ACCOUNT)
    expect(notes).toHaveLength(0)
    expect(await shieldedBalance(ACCOUNT)).toBe(0n)
  })

  it("stores genuine positive notes while skipping 0-value filler notes delivered in the same batch", async () => {
    const filler1 = honest(0n, "01".repeat(32))
    const realNote = honest(1000n, "02".repeat(32))
    const filler2 = honest(0n, "03".repeat(32))

    respondWith([filler1, realNote, filler2])

    const found = await scanForNotes(ACCOUNT, ourBox.secretKey, SPEND_PRIVKEY)
    expect(found).toBe(1)

    const notes = await getNotes(ACCOUNT)
    expect(notes).toHaveLength(1)
    expect(notes[0].amount).toBe("1000")
    expect(notes[0].spent).toBe(false)
    expect(await shieldedBalance(ACCOUNT)).toBe(1000n)
  })
})

describe("addNote commitment deduplication", () => {
  it("deduplicates notes by commitment when signature is empty (change notes)", async () => {
    const changeNote: ShieldedNote = {
      amount: "5000",
      blinding: "aa".repeat(32),
      assetId: "00".repeat(32),
      signature: "", // change notes have empty signature
      createdAt: 100,
      spent: false,
      source: "transfer",
      commitment: "comm_change_12345"
    }

    await addNote(ACCOUNT, changeNote)
    expect(await getNotes(ACCOUNT)).toHaveLength(1)
    expect(await shieldedBalance(ACCOUNT)).toBe(5000n)

    // Attempting to add the identical change note again (e.g. repeated flow or recovery)
    await addNote(ACCOUNT, { ...changeNote, createdAt: 200, amount: "9999" })

    // Must still have only 1 note and balance must NOT be double-counted
    const notes = await getNotes(ACCOUNT)
    expect(notes).toHaveLength(1)
    expect(notes[0].createdAt).toBe(100)
    expect(notes[0].amount).toBe("5000")
    expect(await shieldedBalance(ACCOUNT)).toBe(5000n)
  })

  it("preserves spent status when addNote is called with an already existing commitment", async () => {
    const changeNote: ShieldedNote = {
      amount: "2500",
      blinding: "bb".repeat(32),
      assetId: "00".repeat(32),
      signature: "",
      createdAt: 10,
      spent: true,
      source: "transfer",
      commitment: "comm_spent_note"
    }

    await addNote(ACCOUNT, changeNote)
    // Try adding the same commitment with spent: false
    await addNote(ACCOUNT, { ...changeNote, spent: false })

    const notes = await getNotes(ACCOUNT)
    expect(notes).toHaveLength(1)
    expect(notes[0].spent).toBe(true)
    expect(await shieldedBalance(ACCOUNT)).toBe(0n)
  })

  it("still deduplicates notes with matching deposit signature", async () => {
    const depositNote: ShieldedNote = {
      amount: "3000",
      blinding: "cc".repeat(32),
      assetId: "00".repeat(32),
      signature: "sig_deposit_999",
      createdAt: 50,
      spent: false,
      source: "deposit"
    }

    await addNote(ACCOUNT, depositNote)
    await addNote(ACCOUNT, depositNote)

    expect(await getNotes(ACCOUNT)).toHaveLength(1)
    expect(await shieldedBalance(ACCOUNT)).toBe(3000n)
  })
})

describe("depositV3 input and u64 bounds checks", () => {
  const dummyConnection = {} as Connection
  const keypair = Keypair.generate()
  const wallet = { secretKey: keypair.secretKey }

  it("rejects lamports <= 0n, > MAX_U64, and non-bigint", async () => {
    await expect(depositV3(dummyConnection, wallet, ACCOUNT, SPEND_PRIVKEY, 0n)).rejects.toThrow(
      "deposit amount must be a positive u64"
    )

    await expect(depositV3(dummyConnection, wallet, ACCOUNT, SPEND_PRIVKEY, -1n)).rejects.toThrow(
      "deposit amount must be a positive u64"
    )

    await expect(
      depositV3(dummyConnection, wallet, ACCOUNT, SPEND_PRIVKEY, MAX_U64 + 1n)
    ).rejects.toThrow("deposit amount must be a positive u64")

    await expect(
      depositV3(dummyConnection, wallet, ACCOUNT, SPEND_PRIVKEY, 100 as unknown as bigint)
    ).rejects.toThrow("deposit amount must be a positive u64")
  })

  it("rejects invalid wallet secretKey", async () => {
    await expect(
      depositV3(dummyConnection, { secretKey: new Uint8Array(32) }, ACCOUNT, SPEND_PRIVKEY, 1000n)
    ).rejects.toThrow("invalid wallet secret key")

    await expect(
      depositV3(
        dummyConnection,
        null as unknown as { secretKey: Uint8Array },
        ACCOUNT,
        SPEND_PRIVKEY,
        1000n
      )
    ).rejects.toThrow("invalid wallet secret key")
  })

  it("rejects invalid shieldedAddress and spendPrivkeyHex", async () => {
    await expect(depositV3(dummyConnection, wallet, "", SPEND_PRIVKEY, 1000n)).rejects.toThrow(
      "invalid shielded address"
    )

    await expect(depositV3(dummyConnection, wallet, "   ", SPEND_PRIVKEY, 1000n)).rejects.toThrow(
      "invalid shielded address"
    )

    await expect(depositV3(dummyConnection, wallet, ACCOUNT, "", 1000n)).rejects.toThrow(
      "invalid spend private key"
    )

    await expect(depositV3(dummyConnection, wallet, ACCOUNT, "  ", 1000n)).rejects.toThrow(
      "invalid spend private key"
    )
  })

  it("rejects missing connection", async () => {
    await expect(
      depositV3(null as unknown as Connection, wallet, ACCOUNT, SPEND_PRIVKEY, 1000n)
    ).rejects.toThrow("invalid connection")
  })
})

describe("spendV3 input and u64 bounds checks", () => {
  const dummyConnection = {} as Connection
  const ownBoxPubHex = hex(nacl.box.keyPair().publicKey)

  const makeNote = (overrides: Partial<ShieldedNote> = {}): ShieldedNote => ({
    amount: "1000",
    blinding: "11".repeat(32),
    assetId: "00".repeat(32),
    signature: "",
    createdAt: 1,
    spent: false,
    commitment: "c1",
    source: "transfer",
    ...overrides
  })

  it("rejects payLamports <= 0n, > MAX_U64, and non-bigint", async () => {
    const note = makeNote({ amount: "2000" })
    const dest = { kind: "withdraw" as const, recipientSolanaHex: "aa".repeat(32) }

    await expect(
      spendV3(dummyConnection, ACCOUNT, SPEND_PRIVKEY, ownBoxPubHex, [note], 0n, dest)
    ).rejects.toThrow("pay amount must be a positive u64")

    await expect(
      spendV3(dummyConnection, ACCOUNT, SPEND_PRIVKEY, ownBoxPubHex, [note], -500n, dest)
    ).rejects.toThrow("pay amount must be a positive u64")

    await expect(
      spendV3(dummyConnection, ACCOUNT, SPEND_PRIVKEY, ownBoxPubHex, [note], MAX_U64 + 1n, dest)
    ).rejects.toThrow("pay amount must be a positive u64")

    await expect(
      spendV3(
        dummyConnection,
        ACCOUNT,
        SPEND_PRIVKEY,
        ownBoxPubHex,
        [note],
        100 as unknown as bigint,
        dest
      )
    ).rejects.toThrow("pay amount must be a positive u64")
  })

  it("rejects payLamports > sumIn", async () => {
    const note = makeNote({ amount: "1000" })
    const dest = { kind: "withdraw" as const, recipientSolanaHex: "aa".repeat(32) }

    await expect(
      spendV3(dummyConnection, ACCOUNT, SPEND_PRIVKEY, ownBoxPubHex, [note], 1001n, dest)
    ).rejects.toThrow("amount exceeds the selected notes")
  })

  it("rejects spent notes", async () => {
    const spentNote = makeNote({ amount: "2000", spent: true })
    const dest = { kind: "withdraw" as const, recipientSolanaHex: "aa".repeat(32) }

    await expect(
      spendV3(dummyConnection, ACCOUNT, SPEND_PRIVKEY, ownBoxPubHex, [spentNote], 1000n, dest)
    ).rejects.toThrow("cannot spend spent notes")
  })

  it("rejects duplicate notes", async () => {
    const note = makeNote({ amount: "1000" })
    const dest = { kind: "withdraw" as const, recipientSolanaHex: "aa".repeat(32) }

    await expect(
      spendV3(dummyConnection, ACCOUNT, SPEND_PRIVKEY, ownBoxPubHex, [note, note], 1000n, dest)
    ).rejects.toThrow("cannot spend duplicate notes")

    const noteSameBlind = makeNote({ blinding: note.blinding, commitment: "c2" })
    await expect(
      spendV3(
        dummyConnection,
        ACCOUNT,
        SPEND_PRIVKEY,
        ownBoxPubHex,
        [note, noteSameBlind],
        1000n,
        dest
      )
    ).rejects.toThrow("cannot spend duplicate notes")
  })

  it("rejects notes with amount <= 0n, > MAX_U64, or missing blinding", async () => {
    const dest = { kind: "withdraw" as const, recipientSolanaHex: "aa".repeat(32) }

    const zeroNote = makeNote({ amount: "0" })
    await expect(
      spendV3(dummyConnection, ACCOUNT, SPEND_PRIVKEY, ownBoxPubHex, [zeroNote], 0n, dest)
    ).rejects.toThrow()

    const hugeNote = makeNote({ amount: (MAX_U64 + 100n).toString() })
    await expect(
      spendV3(dummyConnection, ACCOUNT, SPEND_PRIVKEY, ownBoxPubHex, [hugeNote], 1000n, dest)
    ).rejects.toThrow("note amount out of u64 bounds")

    const noBlindNote = makeNote({ blinding: "" })
    await expect(
      spendV3(dummyConnection, ACCOUNT, SPEND_PRIVKEY, ownBoxPubHex, [noBlindNote], 500n, dest)
    ).rejects.toThrow("note missing blinding")
  })

  it("rejects invalid inputs array length", async () => {
    const dest = { kind: "withdraw" as const, recipientSolanaHex: "aa".repeat(32) }

    await expect(
      spendV3(dummyConnection, ACCOUNT, SPEND_PRIVKEY, ownBoxPubHex, [], 100n, dest)
    ).rejects.toThrow("transact spends 1 or 2 notes")

    const n1 = makeNote({ blinding: "01".repeat(32), commitment: "c1" })
    const n2 = makeNote({ blinding: "02".repeat(32), commitment: "c2" })
    const n3 = makeNote({ blinding: "03".repeat(32), commitment: "c3" })

    await expect(
      spendV3(dummyConnection, ACCOUNT, SPEND_PRIVKEY, ownBoxPubHex, [n1, n2, n3], 100n, dest)
    ).rejects.toThrow("transact spends 1 or 2 notes")
  })

  it("rejects invalid destination", async () => {
    const note = makeNote({ amount: "1000" })

    await expect(
      spendV3(dummyConnection, ACCOUNT, SPEND_PRIVKEY, ownBoxPubHex, [note], 500n, {
        kind: "withdraw",
        recipientSolanaHex: ""
      })
    ).rejects.toThrow("invalid withdraw recipient")

    await expect(
      spendV3(dummyConnection, ACCOUNT, SPEND_PRIVKEY, ownBoxPubHex, [note], 500n, {
        kind: "transfer",
        recipientShielded: "  "
      })
    ).rejects.toThrow("invalid transfer recipient")

    await expect(
      spendV3(
        dummyConnection,
        ACCOUNT,
        SPEND_PRIVKEY,
        ownBoxPubHex,
        [note],
        500n,
        null as unknown as { kind: "withdraw"; recipientSolanaHex: string }
      )
    ).rejects.toThrow("invalid destination")
  })

  it("rejects invalid connection, shieldedAddress, spendPrivkeyHex, or ownBoxPubHex", async () => {
    const note = makeNote({ amount: "1000" })
    const dest = { kind: "withdraw" as const, recipientSolanaHex: "aa".repeat(32) }

    await expect(
      spendV3(
        null as unknown as Connection,
        ACCOUNT,
        SPEND_PRIVKEY,
        ownBoxPubHex,
        [note],
        500n,
        dest
      )
    ).rejects.toThrow("invalid connection")

    await expect(
      spendV3(dummyConnection, "", SPEND_PRIVKEY, ownBoxPubHex, [note], 500n, dest)
    ).rejects.toThrow("invalid shielded address")

    await expect(
      spendV3(dummyConnection, ACCOUNT, "", ownBoxPubHex, [note], 500n, dest)
    ).rejects.toThrow("invalid spend private key")

    await expect(
      spendV3(dummyConnection, ACCOUNT, SPEND_PRIVKEY, "", [note], 500n, dest)
    ).rejects.toThrow("invalid box public key")
  })
})
