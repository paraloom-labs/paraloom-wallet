import { describe, it, expect } from "vitest"
import {
  generateMnemonicAndKeypair,
  encryptWallet,
  decryptWallet,
  encryptSeedPhrase,
  decryptSeedPhrase
} from "../lib/crypto/keyManagement"

describe("KDF Fallback Resilience (paraloom-core#873)", () => {
  it("decrypts scrypt vault even when legacy=true is mistakenly passed (missing/tampered kdfVersion)", async () => {
    const { keypair, mnemonic } = await generateMnemonicAndKeypair()
    const password = "TestPassword123!"

    // Modern vault encrypted with scrypt
    const encryptedVault = encryptWallet(keypair, password)

    // Decrypting with legacy=true (simulating unauthenticated kdfVersion missing or forced legacy)
    const decryptedWallet = await decryptWallet(encryptedVault, password, true, true)
    expect(Buffer.from(decryptedWallet.secretKey).toString("hex")).toBe(
      Buffer.from(keypair.secretKey).toString("hex")
    )
  })

  it("decrypts legacy vault even when legacy=false is passed", async () => {
    const { keypair } = await generateMnemonicAndKeypair()
    const password = "TestPassword123!"

    // Simulating legacy vault using legacy key
    const encryptedVault = encryptWallet(keypair, password, true)

    // Attempting decrypt with legacy=false
    const decryptedWallet = await decryptWallet(encryptedVault, password, false, true)
    expect(Buffer.from(decryptedWallet.secretKey).toString("hex")).toBe(
      Buffer.from(keypair.secretKey).toString("hex")
    )
  })

  it("decrypts seed phrase with KDF fallback on mismatch", async () => {
    const password = "TestPassword123!"
    const seed = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    const encryptedSeed = encryptSeedPhrase(seed, password)

    // Decrypting with legacy=true
    const decryptedSeed = decryptSeedPhrase(encryptedSeed, password, true, true)
    expect(decryptedSeed).toBe(seed)
  })

  it("rejects invalid password on both KDF attempts", async () => {
    const { keypair } = await generateMnemonicAndKeypair()
    const encryptedVault = encryptWallet(keypair, "CorrectPassword123!")

    await expect(
      decryptWallet(encryptedVault, "WrongPassword456!", true, true)
    ).rejects.toThrow("Invalid password")
  })
})
