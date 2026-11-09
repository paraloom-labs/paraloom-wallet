import { describe, expect, it, vi } from "vitest"
import * as nacl from "tweetnacl"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  v3NotePubkey: vi.fn(async () => "00".repeat(32))
}))

import {
  deriveBoxKeypair,
  deriveKeypairFromSeed,
  deriveSpendPrivkey,
  decryptWallet,
  encryptWallet,
  decryptSeedPhrase,
  encryptSeedPhrase,
  generateSeedPhrase,
  type EncryptedWallet,
  type WalletKeyPair
} from "~lib/crypto/keyManagement"

const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
const TEST_AUTH_KEY = ["sample", "encryption", "pass", "2026"].join("-")

describe("deriveKeypairFromSeed accountIndex validation (#237)", () => {
  it("derives valid distinct keypairs for valid integer account indices", async () => {
    const acc0 = await deriveKeypairFromSeed(TEST_MNEMONIC, 0)
    const acc1 = await deriveKeypairFromSeed(TEST_MNEMONIC, 1)
    const accMax = await deriveKeypairFromSeed(TEST_MNEMONIC, 0xffffffff)

    expect(acc0.publicKey).toBeInstanceOf(Uint8Array)
    expect(acc0.publicKey.length).toBe(32)
    expect(acc1.publicKey.length).toBe(32)
    expect(accMax.publicKey.length).toBe(32)

    // Ensure account 0, 1, and max derive distinct public keys
    expect(Buffer.from(acc0.publicKey).toString("hex")).not.toBe(
      Buffer.from(acc1.publicKey).toString("hex")
    )
    expect(Buffer.from(acc0.publicKey).toString("hex")).not.toBe(
      Buffer.from(accMax.publicKey).toString("hex")
    )
  })

  it("rejects negative accountIndex", async () => {
    await expect(deriveKeypairFromSeed(TEST_MNEMONIC, -1)).rejects.toThrow("Invalid account index")
    await expect(deriveKeypairFromSeed(TEST_MNEMONIC, -100)).rejects.toThrow("Invalid account index")
  })

  it("rejects floating-point accountIndex", async () => {
    await expect(deriveKeypairFromSeed(TEST_MNEMONIC, 0.9)).rejects.toThrow("Invalid account index")
    await expect(deriveKeypairFromSeed(TEST_MNEMONIC, 1.5)).rejects.toThrow("Invalid account index")
  })

  it("rejects NaN, Infinity, and non-number accountIndex", async () => {
    await expect(deriveKeypairFromSeed(TEST_MNEMONIC, NaN)).rejects.toThrow("Invalid account index")
    await expect(deriveKeypairFromSeed(TEST_MNEMONIC, Infinity)).rejects.toThrow("Invalid account index")
    await expect(deriveKeypairFromSeed(TEST_MNEMONIC, -Infinity)).rejects.toThrow("Invalid account index")
    await expect(deriveKeypairFromSeed(TEST_MNEMONIC, "0" as any)).rejects.toThrow("Invalid account index")
  })

  it("rejects accountIndex exceeding 32-bit unsigned integer range (> 0xFFFFFFFF)", async () => {
    await expect(deriveKeypairFromSeed(TEST_MNEMONIC, 2 ** 32)).rejects.toThrow("Invalid account index")
    await expect(deriveKeypairFromSeed(TEST_MNEMONIC, 2 ** 32 + 10)).rejects.toThrow("Invalid account index")
  })
})

describe("deriveBoxKeypair and deriveSpendPrivkey length validation (#237)", () => {
  it("accepts valid 32-byte seed and 64-byte Ed25519 secretKey", () => {
    const seed32 = new Uint8Array(32).fill(0x11)
    const secret64 = new Uint8Array(64).fill(0x22)

    expect(() => deriveBoxKeypair(seed32)).not.toThrow()
    expect(() => deriveBoxKeypair(secret64)).not.toThrow()
    expect(() => deriveSpendPrivkey(seed32)).not.toThrow()
    expect(() => deriveSpendPrivkey(secret64)).not.toThrow()

    const boxKeys = deriveBoxKeypair(seed32)
    expect(boxKeys.publicKey.length).toBe(32)
    expect(boxKeys.secretKey.length).toBe(32)

    const spendKey = deriveSpendPrivkey(seed32)
    expect(spendKey.length).toBe(32)
  })

  it("rejects truncated keys with length < 32", () => {
    expect(() => deriveBoxKeypair(new Uint8Array(0))).toThrow("Invalid ed25519 secret key length")
    expect(() => deriveBoxKeypair(new Uint8Array(16))).toThrow("Invalid ed25519 secret key length")
    expect(() => deriveBoxKeypair(new Uint8Array(31))).toThrow("Invalid ed25519 secret key length")

    expect(() => deriveSpendPrivkey(new Uint8Array(0))).toThrow("Invalid ed25519 secret key length")
    expect(() => deriveSpendPrivkey(new Uint8Array(16))).toThrow("Invalid ed25519 secret key length")
    expect(() => deriveSpendPrivkey(new Uint8Array(31))).toThrow("Invalid ed25519 secret key length")
  })

  it("rejects lengths other than 32 or 64 bytes", () => {
    expect(() => deriveBoxKeypair(new Uint8Array(48))).toThrow("Invalid ed25519 secret key length")
    expect(() => deriveBoxKeypair(new Uint8Array(65))).toThrow("Invalid ed25519 secret key length")

    expect(() => deriveSpendPrivkey(new Uint8Array(48))).toThrow("Invalid ed25519 secret key length")
    expect(() => deriveSpendPrivkey(new Uint8Array(65))).toThrow("Invalid ed25519 secret key length")
  })
})

describe("decryptWallet envelope & integrity checks (#237)", () => {
  async function makeSampleWallet(): Promise<WalletKeyPair> {
    return deriveKeypairFromSeed(TEST_MNEMONIC, 0)
  }

  it("roundtrips encryptWallet and decryptWallet successfully", async () => {
    const wallet = await makeSampleWallet()
    const encrypted = encryptWallet(wallet, TEST_AUTH_KEY)
    const decrypted = await decryptWallet(encrypted, TEST_AUTH_KEY)

    expect(Buffer.from(decrypted.publicKey).toString("hex")).toBe(
      Buffer.from(wallet.publicKey).toString("hex")
    )
    expect(Buffer.from(decrypted.secretKey).toString("hex")).toBe(
      Buffer.from(wallet.secretKey).toString("hex")
    )
    expect(decrypted.shieldedAddress).toBe(wallet.shieldedAddress)
  })

  it("rejects malformed envelopes before running KDF", async () => {
    const wallet = await makeSampleWallet()
    const valid = encryptWallet(wallet, TEST_AUTH_KEY)

    // Salt wrong length (31 bytes = 62 hex chars)
    const badSalt = { ...valid, salt: "aa".repeat(31) }
    await expect(decryptWallet(badSalt, TEST_AUTH_KEY)).rejects.toThrow("Invalid encrypted wallet envelope")

    // Nonce wrong length (23 bytes = 46 hex chars)
    const badNonce = { ...valid, nonce: "bb".repeat(23) }
    await expect(decryptWallet(badNonce, TEST_AUTH_KEY)).rejects.toThrow("Invalid encrypted wallet envelope")

    // Ciphertext too short (< 16 bytes overhead = 32 hex chars)
    const badCt = { ...valid, encrypted: "cc".repeat(15) }
    await expect(decryptWallet(badCt, TEST_AUTH_KEY)).rejects.toThrow("Invalid encrypted wallet envelope")

    // Non-hex chars
    const nonHex = { ...valid, encrypted: "not-hex-data" }
    await expect(decryptWallet(nonHex, TEST_AUTH_KEY)).rejects.toThrow("Invalid encrypted wallet envelope")

    // Null/undefined/primitive
    await expect(decryptWallet(null as any, TEST_AUTH_KEY)).rejects.toThrow("Invalid encrypted wallet envelope")
  })

  it("detects mismatched secretKey and publicKey upon decryption", async () => {
    // Manually encrypt a payload where publicKey doesn't match secretKey
    const kp1 = nacl.sign.keyPair()
    const kp2 = nacl.sign.keyPair()
    const mismatchedPayload = JSON.stringify({
      publicKey: Buffer.from(kp2.publicKey).toString("hex"), // Mismatched pubkey!
      secretKey: Buffer.from(kp1.secretKey).toString("hex"),
      shieldedAddress: "paraloom1test"
    })

    const salt = new Uint8Array(32).fill(0x01)
    const nonce = new Uint8Array(nacl.secretbox.nonceLength).fill(0x02)
    const key = new Uint8Array(32).fill(0x03)
    const cipher = nacl.secretbox(new TextEncoder().encode(mismatchedPayload), nonce, key)

    const corruptedEnvelope: EncryptedWallet = {
      salt: Buffer.from(salt).toString("hex"),
      nonce: Buffer.from(nonce).toString("hex"),
      encrypted: Buffer.from(cipher).toString("hex")
    }

    // Mock deriveKey to return our fixed key
    const deriveKeySpy = vi.spyOn(await import("~lib/crypto/keyManagement"), "decryptWallet")
    // When decrypting with any pass, if secretbox opens, it must fail integrity check
    // We can directly call decryptWallet by mocking deriveKey behavior or using real scrypt
    const realEncrypted = encryptWallet({
      publicKey: kp2.publicKey, // mismatched
      secretKey: kp1.secretKey,
      shieldedAddress: "paraloom1test",
      boxPublicKey: new Uint8Array(32),
      boxSecretKey: new Uint8Array(32),
      spendPrivkey: new Uint8Array(32)
    }, TEST_AUTH_KEY)

    await expect(decryptWallet(realEncrypted, TEST_AUTH_KEY)).rejects.toThrow(
      "Invalid wallet keypair data: secretKey and publicKey mismatch"
    )
  })

  it("rejects wrong passphrase", async () => {
    const wallet = await makeSampleWallet()
    const encrypted = encryptWallet(wallet, TEST_AUTH_KEY)
    await expect(decryptWallet(encrypted, "wrong-passphrase")).rejects.toThrow("Invalid password")
  })
})

describe("decryptSeedPhrase envelope & mnemonic validation (#237)", () => {
  it("roundtrips encryptSeedPhrase and decryptSeedPhrase successfully", () => {
    const encryptedHex = encryptSeedPhrase(TEST_MNEMONIC, TEST_AUTH_KEY)
    const recovered = decryptSeedPhrase(encryptedHex, TEST_AUTH_KEY)
    expect(recovered).toBe(TEST_MNEMONIC)
  })

  it("rejects truncated or non-hex encryptedData envelopes before running KDF", () => {
    // Minimum byte length: 32 (salt) + 24 (nonce) + 16 (overhead) = 72 bytes = 144 hex chars
    expect(() => decryptSeedPhrase("aa".repeat(71), TEST_AUTH_KEY)).toThrow("Invalid encrypted seed phrase envelope")
    expect(() => decryptSeedPhrase("not-a-valid-hex-string", TEST_AUTH_KEY)).toThrow("Invalid encrypted seed phrase envelope")
    expect(() => decryptSeedPhrase("", TEST_AUTH_KEY)).toThrow("Invalid encrypted seed phrase envelope")
  })

  it("rejects wrong passphrase", () => {
    const encryptedHex = encryptSeedPhrase(TEST_MNEMONIC, TEST_AUTH_KEY)
    expect(() => decryptSeedPhrase(encryptedHex, "wrong-passphrase")).toThrow("Invalid password")
  })

  it("rejects decrypted payload that is not a valid BIP-39 mnemonic", () => {
    // Encrypt an invalid mnemonic string
    const notMnemonic = "hello world foo bar baz invalid phrase test sample words"
    const salt = new Uint8Array(32).fill(0x05)
    const nonce = new Uint8Array(nacl.secretbox.nonceLength).fill(0x06)
    // We can encrypt with encryptSeedPhrase since it accepts any string
    const encryptedHex = encryptSeedPhrase(notMnemonic, TEST_AUTH_KEY)
    expect(() => decryptSeedPhrase(encryptedHex, TEST_AUTH_KEY)).toThrow("Decrypted seed phrase is invalid")
  })
})
