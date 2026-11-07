import {
  decryptSeedPhrase,
  decryptWallet,
  deriveBoxKeypair,
  deriveKeypairFromSeed,
  deriveSpendPrivkey,
  encryptSeedPhrase,
  encryptWallet,
  generateSeedPhrase,
  type WalletKeyPair
} from "~lib/crypto/keyManagement"
import * as nacl from "tweetnacl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { installFakeChrome } from "./support/chromeStorage"

vi.mock("~lib/prover", () => ({
  v3NotePubkey: vi.fn(async (privkeyHex: string) => `pub_${privkeyHex}`),
  NATIVE_ASSET_HEX: "00".repeat(32)
}))

const TEST_SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
const TEST_PASSWORD = "test-secure-password-123"

beforeEach(() => {
  installFakeChrome()
  vi.clearAllMocks()
})

describe("deriveKeypairFromSeed accountIndex validation", () => {
  it("derives valid keypairs for non-negative integer account indices", async () => {
    const acc0 = await deriveKeypairFromSeed(TEST_SEED_PHRASE, 0)
    expect(acc0.publicKey).toHaveLength(32)
    expect(acc0.secretKey).toHaveLength(64)
    expect(acc0.shieldedAddress).toMatch(/^paraloom1/)

    const acc1 = await deriveKeypairFromSeed(TEST_SEED_PHRASE, 1)
    expect(Buffer.from(acc0.publicKey).toString("hex")).not.toBe(
      Buffer.from(acc1.publicKey).toString("hex")
    )

    // Max u32 index 4294967295 (0xffffffff)
    const accMax = await deriveKeypairFromSeed(TEST_SEED_PHRASE, 0xffffffff)
    expect(accMax.publicKey).toHaveLength(32)
  })

  it("throws Invalid account index on negative accountIndex", async () => {
    await expect(deriveKeypairFromSeed(TEST_SEED_PHRASE, -1)).rejects.toThrow(
      "Invalid account index"
    )
    await expect(deriveKeypairFromSeed(TEST_SEED_PHRASE, -100)).rejects.toThrow(
      "Invalid account index"
    )
  })

  it("throws Invalid account index on float accountIndex", async () => {
    await expect(deriveKeypairFromSeed(TEST_SEED_PHRASE, 1.5)).rejects.toThrow(
      "Invalid account index"
    )
    await expect(deriveKeypairFromSeed(TEST_SEED_PHRASE, 0.1)).rejects.toThrow(
      "Invalid account index"
    )
  })

  it("throws Invalid account index on NaN, Infinity, -Infinity", async () => {
    await expect(deriveKeypairFromSeed(TEST_SEED_PHRASE, NaN)).rejects.toThrow(
      "Invalid account index"
    )
    await expect(deriveKeypairFromSeed(TEST_SEED_PHRASE, Infinity)).rejects.toThrow(
      "Invalid account index"
    )
    await expect(deriveKeypairFromSeed(TEST_SEED_PHRASE, -Infinity)).rejects.toThrow(
      "Invalid account index"
    )
  })

  it("throws Invalid account index when accountIndex exceeds 0xffffffff", async () => {
    await expect(deriveKeypairFromSeed(TEST_SEED_PHRASE, 0x100000000)).rejects.toThrow(
      "Invalid account index"
    )
  })

  it("throws Invalid seed phrase on malformed mnemonic", async () => {
    await expect(deriveKeypairFromSeed("not a valid seed phrase", 0)).rejects.toThrow(
      "Invalid seed phrase"
    )
  })
})

describe("deriveSpendPrivkey and deriveBoxKeypair truncated seeds validation", () => {
  it("rejects truncated seeds (< 32 bytes) in deriveSpendPrivkey", () => {
    expect(() => deriveSpendPrivkey(new Uint8Array(0))).toThrow(
      "Secret key must be at least 32 bytes"
    )
    expect(() => deriveSpendPrivkey(new Uint8Array(16))).toThrow(
      "Secret key must be at least 32 bytes"
    )
    expect(() => deriveSpendPrivkey(new Uint8Array(31))).toThrow(
      "Secret key must be at least 32 bytes"
    )
  })

  it("rejects truncated seeds (< 32 bytes) in deriveBoxKeypair", () => {
    expect(() => deriveBoxKeypair(new Uint8Array(0))).toThrow(
      "Secret key must be at least 32 bytes"
    )
    expect(() => deriveBoxKeypair(new Uint8Array(16))).toThrow(
      "Secret key must be at least 32 bytes"
    )
    expect(() => deriveBoxKeypair(new Uint8Array(31))).toThrow(
      "Secret key must be at least 32 bytes"
    )
  })

  it("accepts valid 32-byte seed and 64-byte secretKey in deriveSpendPrivkey and deriveBoxKeypair", () => {
    const seed32 = new Uint8Array(32).fill(0x42)
    const priv32 = deriveSpendPrivkey(seed32)
    expect(priv32).toHaveLength(32)

    const boxKeypair32 = deriveBoxKeypair(seed32)
    expect(boxKeypair32.publicKey).toHaveLength(32)
    expect(boxKeypair32.secretKey).toHaveLength(32)

    const kp64 = nacl.sign.keyPair.fromSeed(seed32)
    const priv64 = deriveSpendPrivkey(kp64.secretKey)
    expect(priv64).toEqual(priv32)

    const boxKeypair64 = deriveBoxKeypair(kp64.secretKey)
    expect(boxKeypair64.publicKey).toEqual(boxKeypair32.publicKey)
    expect(boxKeypair64.secretKey).toEqual(boxKeypair32.secretKey)
  })
})

describe("decryptWallet secretbox and ed25519 keypair integrity checks", () => {
  it("successfully encrypts and decrypts a wallet", async () => {
    const keypair = await deriveKeypairFromSeed(TEST_SEED_PHRASE, 0)
    const encrypted = encryptWallet(keypair, TEST_PASSWORD)

    const decrypted = await decryptWallet(encrypted, TEST_PASSWORD)
    expect(Buffer.from(decrypted.publicKey).toString("hex")).toBe(
      Buffer.from(keypair.publicKey).toString("hex")
    )
    expect(Buffer.from(decrypted.secretKey).toString("hex")).toBe(
      Buffer.from(keypair.secretKey).toString("hex")
    )
    expect(decrypted.shieldedAddress).toBe(keypair.shieldedAddress)
  })

  it("throws Invalid password when password is incorrect", async () => {
    const keypair = await deriveKeypairFromSeed(TEST_SEED_PHRASE, 0)
    const encrypted = encryptWallet(keypair, TEST_PASSWORD)

    await expect(decryptWallet(encrypted, "wrong-password")).rejects.toThrow("Invalid password")
  })

  it("rejects malformed secretbox structure, salt, nonce, and ciphertext lengths", async () => {
    const keypair = await deriveKeypairFromSeed(TEST_SEED_PHRASE, 0)
    const encrypted = encryptWallet(keypair, TEST_PASSWORD)

    // Salt wrong length
    await expect(decryptWallet({ ...encrypted, salt: "aabb" }, TEST_PASSWORD)).rejects.toThrow(
      "Invalid encrypted wallet data"
    )

    // Nonce wrong length
    await expect(decryptWallet({ ...encrypted, nonce: "aabb" }, TEST_PASSWORD)).rejects.toThrow(
      "Invalid encrypted wallet data"
    )

    // Encrypted too short (< 16 overhead)
    await expect(decryptWallet({ ...encrypted, encrypted: "aabb" }, TEST_PASSWORD)).rejects.toThrow(
      "Invalid encrypted wallet data"
    )

    // Null or non-object
    await expect(decryptWallet(null as unknown as typeof encrypted, TEST_PASSWORD)).rejects.toThrow(
      "Invalid encrypted wallet data"
    )
  })

  it("rejects walletData when secretKey or publicKey length is invalid", async () => {
    // Encrypt a payload with invalid key lengths
    const salt = new Uint8Array(32).fill(1)
    const nonce = new Uint8Array(24).fill(2)
    // Derive key using scrypt as in encryptWallet
    const { scrypt } = await import("@noble/hashes/scrypt")
    const encKey = scrypt(new TextEncoder().encode(TEST_PASSWORD), salt, {
      N: 2 ** 15,
      r: 8,
      p: 1,
      dkLen: 32
    })

    const badData = JSON.stringify({
      publicKey: "aabbcc", // invalid length
      secretKey: Buffer.from(new Uint8Array(64).fill(3)).toString("hex")
    })
    const ct = nacl.secretbox(new TextEncoder().encode(badData), nonce, encKey)

    const corruptedWallet = {
      salt: Buffer.from(salt).toString("hex"),
      nonce: Buffer.from(nonce).toString("hex"),
      encrypted: Buffer.from(ct).toString("hex")
    }

    await expect(decryptWallet(corruptedWallet, TEST_PASSWORD)).rejects.toThrow(
      "Wallet integrity check failed"
    )
  })

  it("rejects walletData when publicKey does not match secretKey (mismatched keypair)", async () => {
    const salt = new Uint8Array(32).fill(1)
    const nonce = new Uint8Array(24).fill(2)
    const { scrypt } = await import("@noble/hashes/scrypt")
    const encKey = scrypt(new TextEncoder().encode(TEST_PASSWORD), salt, {
      N: 2 ** 15,
      r: 8,
      p: 1,
      dkLen: 32
    })

    const kp1 = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(10))
    const kp2 = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(20))

    // Pair kp1's secretKey with kp2's publicKey
    const mismatchedData = JSON.stringify({
      publicKey: Buffer.from(kp2.publicKey).toString("hex"),
      secretKey: Buffer.from(kp1.secretKey).toString("hex")
    })
    const ct = nacl.secretbox(new TextEncoder().encode(mismatchedData), nonce, encKey)

    const corruptedWallet = {
      salt: Buffer.from(salt).toString("hex"),
      nonce: Buffer.from(nonce).toString("hex"),
      encrypted: Buffer.from(ct).toString("hex")
    }

    await expect(decryptWallet(corruptedWallet, TEST_PASSWORD)).rejects.toThrow(
      "Wallet integrity check failed"
    )
  })

  it("rejects walletData when secretKey seed does not regenerate secretKey/publicKey", async () => {
    const salt = new Uint8Array(32).fill(1)
    const nonce = new Uint8Array(24).fill(2)
    const { scrypt } = await import("@noble/hashes/scrypt")
    const encKey = scrypt(new TextEncoder().encode(TEST_PASSWORD), salt, {
      N: 2 ** 15,
      r: 8,
      p: 1,
      dkLen: 32
    })

    const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(10))
    const tamperedSecret = new Uint8Array(kp.secretKey)
    // Tamper with the seed half
    tamperedSecret[0] ^= 0xff
    // But keep the pubkey half matching kp.publicKey so secretKey.slice(32) matches publicKey
    tamperedSecret.set(kp.publicKey, 32)

    const tamperedData = JSON.stringify({
      publicKey: Buffer.from(kp.publicKey).toString("hex"),
      secretKey: Buffer.from(tamperedSecret).toString("hex")
    })
    const ct = nacl.secretbox(new TextEncoder().encode(tamperedData), nonce, encKey)

    const corruptedWallet = {
      salt: Buffer.from(salt).toString("hex"),
      nonce: Buffer.from(nonce).toString("hex"),
      encrypted: Buffer.from(ct).toString("hex")
    }

    await expect(decryptWallet(corruptedWallet, TEST_PASSWORD)).rejects.toThrow(
      "Wallet integrity check failed"
    )
  })
})

describe("decryptSeedPhrase integrity checks", () => {
  it("successfully encrypts and decrypts a seed phrase", () => {
    const encrypted = encryptSeedPhrase(TEST_SEED_PHRASE, TEST_PASSWORD)
    const decrypted = decryptSeedPhrase(encrypted, TEST_PASSWORD)
    expect(decrypted).toBe(TEST_SEED_PHRASE)
  })

  it("rejects wrong password in decryptSeedPhrase", () => {
    const encrypted = encryptSeedPhrase(TEST_SEED_PHRASE, TEST_PASSWORD)
    expect(() => decryptSeedPhrase(encrypted, "wrong-password")).toThrow("Invalid password")
  })

  it("rejects truncated encrypted data (< 72 bytes) in decryptSeedPhrase", () => {
    expect(() => decryptSeedPhrase("aabbcc", TEST_PASSWORD)).toThrow("Invalid encrypted data")
    expect(() => decryptSeedPhrase("", TEST_PASSWORD)).toThrow("Invalid encrypted data")
  })

  it("rejects decrypted plaintext that is not a valid BIP39 seed phrase", async () => {
    // Encrypt arbitrary text instead of a valid BIP39 mnemonic
    const salt = new Uint8Array(32).fill(1)
    const nonce = new Uint8Array(24).fill(2)
    const { scrypt } = await import("@noble/hashes/scrypt")
    const encKey = scrypt(new TextEncoder().encode(TEST_PASSWORD), salt, {
      N: 2 ** 15,
      r: 8,
      p: 1,
      dkLen: 32
    })

    const invalidMnemonic = "this is not a valid twelve word bip thirty nine seed phrase at all"
    const ct = nacl.secretbox(new TextEncoder().encode(invalidMnemonic), nonce, encKey)

    const combined = new Uint8Array(salt.length + nonce.length + ct.length)
    combined.set(salt)
    combined.set(nonce, salt.length)
    combined.set(ct, salt.length + nonce.length)

    const encryptedHex = Buffer.from(combined).toString("hex")

    expect(() => decryptSeedPhrase(encryptedHex, TEST_PASSWORD)).toThrow(
      "Invalid seed phrase integrity"
    )
  })
})
