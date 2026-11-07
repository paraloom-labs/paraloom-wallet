import { describe, expect, it, vi } from "vitest"
import * as nacl from "tweetnacl"
import { scrypt } from "@noble/hashes/scrypt"
import { randomBytes } from "@noble/hashes/utils"

vi.mock("~lib/prover", () => ({
  v3NotePubkey: async (privkeyHex: string) => privkeyHex
}))

import {
  decryptSeedPhrase,
  decryptWallet,
  deriveBoxKeypair,
  deriveKeypairFromSeed,
  deriveSpendPrivkey,
  encryptSeedPhrase,
  encryptWallet
} from "~lib/crypto/keyManagement"

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

describe("keyManagement account index, secret key, and vault integrity guards", () => {
  it("deriveKeypairFromSeed rejects negative, float, NaN, and > u32::MAX accountIndex values", async () => {
    const kp0 = await deriveKeypairFromSeed(TEST_MNEMONIC, 0)
    expect(kp0.publicKey.length).toBe(32)
    expect(kp0.secretKey.length).toBe(64)

    for (const badIdx of [-1, 0.5, 1.9, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 32]) {
      await expect(deriveKeypairFromSeed(TEST_MNEMONIC, badIdx)).rejects.toThrow(
        "Invalid account index"
      )
    }
  })

  it("deriveBoxKeypair and deriveSpendPrivkey reject truncated (< 32-byte) secret keys", () => {
    for (const len of [0, 1, 16, 31, 33, 63, 65]) {
      expect(() => deriveBoxKeypair(new Uint8Array(len))).toThrow(
        "Invalid Ed25519 secret key length"
      )
      expect(() => deriveSpendPrivkey(new Uint8Array(len))).toThrow(
        "Invalid Ed25519 secret key length"
      )
    }
    expect(deriveSpendPrivkey(new Uint8Array(32)).length).toBe(32)
    expect(deriveSpendPrivkey(new Uint8Array(64)).length).toBe(32)
  })

  it("decryptWallet and decryptSeedPhrase reject malformed envelopes pre-KDF and detect mismatched publicKey or corrupted mnemonic", async () => {
    const kp = await deriveKeypairFromSeed(TEST_MNEMONIC, 0)
    const enc = encryptWallet(kp, "StrongPass123!")
    const dec = await decryptWallet(enc, "StrongPass123!")
    expect(Buffer.from(dec.publicKey).equals(Buffer.from(kp.publicKey))).toBe(true)

    // Truncated nonce/salt rejected immediately
    await expect(
      decryptWallet({ ...enc, nonce: "abcd" }, "StrongPass123!")
    ).rejects.toThrow("Malformed encrypted wallet payload")
    await expect(
      decryptWallet({ ...enc, salt: "abcd" }, "StrongPass123!")
    ).rejects.toThrow("Malformed encrypted wallet payload")
    expect(() => decryptSeedPhrase("abcd", "StrongPass123!")).toThrow(
      "Malformed encrypted wallet payload"
    )

    // Craft a vault where publicKey does not match secretKey
    const salt = randomBytes(32)
    const key = scrypt(new TextEncoder().encode("StrongPass123!"), salt, {
      N: 2 ** 15,
      r: 8,
      p: 1,
      dkLen: 32
    })
    const nonce = randomBytes(nacl.secretbox.nonceLength)
    const wrongPub = new Uint8Array(32).fill(9)
    const tamperedPayload = new TextEncoder().encode(
      JSON.stringify({
        publicKey: Buffer.from(wrongPub).toString("hex"),
        secretKey: Buffer.from(kp.secretKey).toString("hex"),
        shieldedAddress: kp.shieldedAddress
      })
    )
    const ct = nacl.secretbox(tamperedPayload, nonce, key)
    await expect(
      decryptWallet(
        {
          encrypted: Buffer.from(ct).toString("hex"),
          nonce: Buffer.from(nonce).toString("hex"),
          salt: Buffer.from(salt).toString("hex")
        },
        "StrongPass123!"
      )
    ).rejects.toThrow("Corrupted wallet keypair: publicKey does not match secretKey")

    // Valid seed phrase roundtrips, non-BIP39 plaintext rejected
    const encSeed = encryptSeedPhrase(TEST_MNEMONIC, "StrongPass123!")
    expect(decryptSeedPhrase(encSeed, "StrongPass123!")).toBe(TEST_MNEMONIC)
    const badSeedBlob = encryptSeedPhrase("not a valid mnemonic phrase", "StrongPass123!")
    expect(() => decryptSeedPhrase(badSeedBlob, "StrongPass123!")).toThrow(
      "Corrupted seed phrase in vault"
    )
  })
})
