import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  isLegacyShieldedAddress,
  normalizeShieldedAddress,
  shieldedAddressBody,
  withChecksum
} from "~lib/crypto/addressChecksum"
import {
  addressBoxPubHex,
  addressSpendPubHex
} from "~lib/crypto/keyManagement"
import type { ShieldedNote } from "~lib/paraloom/notes"
import { spendV3 } from "~lib/paraloom/transactFlow"
import { transfer } from "~lib/paraloom/transfer"

// The prover wasm cannot load under vitest; the boundary guards under test
// run before any proving, so the prover surface is stubbed.
const proverStub = vi.hoisted(() => ({
  proveTransferV2: vi.fn(async () => ({})),
  proveTransact: vi.fn(async () => ({}))
}))

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  assetIdForMint: vi.fn(async () => "ab".repeat(32)),
  noteCommitmentV2: vi.fn(async () => "cc".repeat(32)),
  proveTransferV2: proverStub.proveTransferV2,
  proveTransact: proverStub.proveTransact,
  v3MerklePath: vi.fn(async () => ({})),
  v3NoteCommitment: vi.fn(async () => "cc".repeat(32)),
  v3NoteCommitmentAsset: vi.fn(async () => "cc".repeat(32)),
  v3NotePubkey: vi.fn(async () => "dd".repeat(32))
}))

const BODY = "ab".repeat(64) // 128 hex chars: box(64) || spend(64)
const CHECKSUMMED = `paraloom1${withChecksum(BODY)}`
const LEGACY = `paraloom1${BODY}`
// One body character flipped, original checksum kept: the #781 typo.
const TYPO = `paraloom1${"c" + BODY.slice(1)}${CHECKSUMMED.slice(-8)}`

const ACCOUNT = "paraloom1" + "11".repeat(64)

function note(amount: string): ShieldedNote {
  return {
    amount,
    blinding: "aa".repeat(32),
    assetId: "00".repeat(32),
    signature: "sig",
    createdAt: 1,
    spent: false,
    source: "deposit"
  }
}

beforeEach(() => {
  proverStub.proveTransferV2.mockClear()
  proverStub.proveTransact.mockClear()
  global.fetch = vi.fn(async () => {
    throw new Error("sentinel-network")
  }) as never
})

describe("shieldedAddressBody / normalizeShieldedAddress (#116)", () => {
  it("extracts the body from checksummed and legacy addresses alike", () => {
    expect(shieldedAddressBody(CHECKSUMMED)).toBe(BODY)
    expect(shieldedAddressBody(LEGACY)).toBe(BODY)
    expect(isLegacyShieldedAddress(LEGACY)).toBe(true)
    expect(isLegacyShieldedAddress(CHECKSUMMED)).toBe(false)
  })

  it("never degrades a typo'd checksummed address to 'legacy'", () => {
    expect(shieldedAddressBody(TYPO)).toBeNull()
    expect(normalizeShieldedAddress(TYPO)).toBeNull()
  })

  it("normalizes a legacy address to its checksummed form", () => {
    expect(normalizeShieldedAddress(LEGACY)).toBe(CHECKSUMMED)
    expect(normalizeShieldedAddress(CHECKSUMMED)).toBe(CHECKSUMMED)
    expect(normalizeShieldedAddress("paraloom1xyz")).toBeNull()
    expect(normalizeShieldedAddress("not-an-address")).toBeNull()
  })
})

describe("key slicing helpers (#116)", () => {
  it("slice both eras of address to the same key halves", () => {
    for (const addr of [CHECKSUMMED, LEGACY]) {
      expect(addressBoxPubHex(addr)).toBe(BODY.slice(0, 64))
      expect(addressSpendPubHex(addr)).toBe(BODY.slice(64, 128))
    }
  })

  it("throw on a typo'd checksummed address or garbage instead of slicing blindly", () => {
    expect(() => addressBoxPubHex(TYPO)).toThrow(/Invalid shielded address/)
    expect(() => addressSpendPubHex(TYPO)).toThrow(/Invalid shielded address/)
    expect(() => addressBoxPubHex("paraloom1zz")).toThrow(
      /Invalid shielded address/
    )
  })
})

describe("transfer() boundary validation (#116)", () => {
  const inputs: [ShieldedNote, ShieldedNote] = [note("2000"), note("2000")]

  it("rejects a typo'd recipient before any proving or network work", async () => {
    await expect(
      transfer(ACCOUNT, CHECKSUMMED, TYPO, 1000n, inputs, "00".repeat(32))
    ).rejects.toThrow(/checksum/)
    expect(proverStub.proveTransferV2).not.toHaveBeenCalled()
  })

  it("accepts a legacy (pre-checksum) OWN address instead of freezing the user out", async () => {
    // Validation and derivation pass; the flow proceeds to the path server,
    // whose fetch is stubbed to fail with a sentinel — proving the address
    // checks are not what stopped it.
    await expect(
      transfer(ACCOUNT, LEGACY, CHECKSUMMED, 1000n, inputs, "00".repeat(32))
    ).rejects.toThrow("sentinel-network")
  })

  it("rejects a malformed OWN address with an address error", async () => {
    await expect(
      transfer(ACCOUNT, "garbage", CHECKSUMMED, 1000n, inputs, "00".repeat(32))
    ).rejects.toThrow(/Own shielded address is malformed/)
    expect(proverStub.proveTransferV2).not.toHaveBeenCalled()
  })
})

describe("spendV3() boundary validation (#116)", () => {
  it("rejects a typo'd shielded destination before proving", async () => {
    await expect(
      spendV3(
        {} as never,
        CHECKSUMMED,
        "00".repeat(32),
        BODY.slice(0, 64),
        [note("2000")],
        1000n,
        { kind: "transfer", recipientShielded: TYPO }
      )
    ).rejects.toThrow(/checksum/)
    expect(proverStub.proveTransact).not.toHaveBeenCalled()
  })
})
