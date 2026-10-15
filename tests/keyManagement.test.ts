import { describe, expect, it, vi } from "vitest"

// keyManagement derives the v3 shielded address while opening a wallet. Keep
// these crypto-format tests independent from the proving WASM binary.
vi.mock("~lib/prover", () => ({
  v3NotePubkey: async () => "ab".repeat(32)
}))

import { sha256 } from "@noble/hashes/sha256"
import { randomBytes } from "@noble/hashes/utils"
import * as nacl from "tweetnacl"
import {
  decryptSeedPhrase,
  decryptWallet,
  encryptSeedPhrase,
  encryptWallet,
  type EncryptedWallet,
  type WalletKeyPair
} from "~lib/crypto/keyManagement"

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")

function deriveLegacyKey(password: string, salt: Uint8Array): Uint8Array {
  let key = new TextEncoder().encode(password)
  for (let i = 0; i < 100_000; i++) {
    const input = new Uint8Array(key.length + salt.length)
    input.set(key)
    input.set(salt, key.length)
    key = sha256(input)
  }
  return key
}

function encryptLegacySeedPhrase(seedPhrase: string, password: string): string {
  const salt = randomBytes(32)
  const nonce = randomBytes(nacl.secretbox.nonceLength)
  const encrypted = nacl.secretbox(
    new TextEncoder().encode(seedPhrase),
    nonce,
    deriveLegacyKey(password, salt)
  )
  const combined = new Uint8Array(salt.length + nonce.length + encrypted.length)
  combined.set(salt)
  combined.set(nonce, salt.length)
  combined.set(encrypted, salt.length + nonce.length)
  return hex(combined)
}

function encryptLegacyWallet(
  keypair: nacl.SignKeyPair,
  password: string
): EncryptedWallet {
  const salt = randomBytes(32)
  const nonce = randomBytes(nacl.secretbox.nonceLength)
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      publicKey: hex(keypair.publicKey),
      secretKey: hex(keypair.secretKey),
      shieldedAddress: "legacy-address"
    })
  )
  const encrypted = nacl.secretbox(plaintext, nonce, deriveLegacyKey(password, salt))
  return { encrypted: hex(encrypted), nonce: hex(nonce), salt: hex(salt) }
}

const TEST_PASSWORD = "correct horse battery staple"

function walletForEncryption(keypair: nacl.SignKeyPair): WalletKeyPair {
  return {
    publicKey: keypair.publicKey,
    secretKey: keypair.secretKey,
    shieldedAddress: "current-address",
    boxPublicKey: new Uint8Array(32),
    boxSecretKey: new Uint8Array(32),
    spendPrivkey: new Uint8Array(32)
  }
}

describe("KDF fallback for unversioned vaults", () => {
  it("opens a current scrypt vault when the marker selects legacy KDF", async () => {
    const keypair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7))
    const encrypted = encryptWallet(walletForEncryption(keypair), TEST_PASSWORD)

    const opened = await decryptWallet(encrypted, TEST_PASSWORD, true)

    expect(hex(opened.secretKey)).toBe(hex(keypair.secretKey))
  })

  it("opens a legacy seed phrase when the marker selects scrypt KDF", () => {
    const encrypted = encryptLegacySeedPhrase("abandon ability able about", TEST_PASSWORD)

    expect(decryptSeedPhrase(encrypted, TEST_PASSWORD, false)).toBe(
      "abandon ability able about"
    )
  })

  it("opens a legacy wallet when the marker selects scrypt KDF", async () => {
    const keypair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9))
    const encrypted = encryptLegacyWallet(keypair, TEST_PASSWORD)

    const opened = await decryptWallet(encrypted, TEST_PASSWORD, false)

    expect(hex(opened.secretKey)).toBe(hex(keypair.secretKey))
  })

  it("still rejects a password that fails both KDFs", () => {
    const encrypted = encryptSeedPhrase("abandon ability able about", TEST_PASSWORD)

    expect(() => decryptSeedPhrase(encrypted, "wrong password", true)).toThrow(
      "Invalid password"
    )
  })
})
