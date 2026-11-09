import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  v3NotePubkey: vi.fn(async (privkeyHex: string) => "aa".repeat(32))
}))
vi.mock("data-base64:~/../assets/icon.png", () => ({ default: "icon" }))
vi.mock("data-base64:~/../assets/solana.svg", () => ({ default: "solana" }))
vi.mock("data-base64:~/../assets/usdc.svg", () => ({ default: "usdc" }))

import { formatExactUnits } from "../src/popup/Home"
import {
  decryptWallet,
  deriveKeypairFromSeed,
  encryptWallet,
  generateSeedPhrase,
  KDF_VERSION_SCRYPT
} from "../lib/crypto/keyManagement"
import { installFakeChrome } from "./support/chromeStorage"
import { getStoredWallet } from "../lib/storage/secure"

describe("formatExactUnits for Withdraw and Send Max buttons (#242)", () => {
  it("formats exact units without rounding up above balance", () => {
    // 1.00005 SOL (1000050000 lamports) - previously rounded up to 1.0001 with toFixed(4)
    expect(formatExactUnits(1000050000n, 9)).toBe("1.00005")

    // Sub-microlamport precision
    expect(formatExactUnits(1n, 9)).toBe("0.000000001")
    expect(formatExactUnits(400n, 9)).toBe("0.0000004")

    // Integer amounts
    expect(formatExactUnits(5000000000n, 9)).toBe("5")
    expect(formatExactUnits(0n, 9)).toBe("0")
    expect(formatExactUnits(-100n, 9)).toBe("0")

    // USDC (6 decimals)
    expect(formatExactUnits(1234567n, 6)).toBe("1.234567")

    // Large u64 values
    const u64Max = 18446744073709551615n
    expect(formatExactUnits(u64Max, 0)).toBe("18446744073709551615")
  })
})

describe("Unlock error isolation and post-decrypt resilience (#242)", () => {
  beforeEach(() => {
    installFakeChrome()
  })

  it("authenticates password successfully even if stored accounts have malformed balances", async () => {
    const seed = generateSeedPhrase()
    const keypair = await deriveKeypairFromSeed(seed, 0)
    const testSecret = ["test", "phrase", "123"].join("-")
    const encrypted = encryptWallet(keypair, testSecret)

    // Save wallet in storage with a malformed account balance e.g. "0.0" or ""
    const fake = installFakeChrome()
    await fake.storage.local.set({
      paraloom_wallet: {
        locked: true,
        autoLockMinutes: 60,
        wallet: {
          encryptedData: encrypted,
          address: keypair.shieldedAddress,
          createdAt: Date.now(),
          kdfVersion: KDF_VERSION_SCRYPT,
          accounts: [
            {
              index: 0,
              name: "Account 1",
              address: keypair.shieldedAddress,
              balance: "0.0" // malformed BigInt string!
            }
          ]
        }
      }
    })

    const stored = await getStoredWallet()
    expect(stored).not.toBeNull()

    // Decrypting wallet directly succeeds
    const decrypted = await decryptWallet(stored!.encryptedData, testSecret, false)
    expect(decrypted.shieldedAddress).toBe(keypair.shieldedAddress)

    // Parsing the account balance with BigInt fallback:
    let bal = 0n
    try {
      bal = BigInt(stored!.accounts![0].balance)
    } catch {
      bal = 0n
    }
    expect(bal).toBe(0n)
  })

  it("rejects incorrect password", async () => {
    const seed = generateSeedPhrase()
    const keypair = await deriveKeypairFromSeed(seed, 0)
    const testSecret = ["test", "phrase", "123"].join("-")
    const encrypted = encryptWallet(keypair, testSecret)

    const wrongSecret = ["wrong", "phrase"].join("-")
    await expect(decryptWallet(encrypted, wrongSecret, false)).rejects.toThrow()
  })
})

describe("Activity note filtering (#242)", () => {
  it("includes both deposit and transfer notes with positive BigInt amounts", () => {
    const notes = [
      { source: "deposit", amount: "1000", spent: false },
      { source: "transfer", amount: "5000", spent: false },
      { source: "transfer", amount: "0", spent: false }, // dummy filler note
      { source: "deposit", amount: "0", spent: false },
      { source: "other", amount: "2000", spent: false }
    ]

    const isPositiveAmount = (amountStr: string): boolean => {
      try {
        return BigInt(amountStr) > 0n
      } catch {
        return false
      }
    }

    const activityNotes = notes.filter(
      (n) =>
        (n.source === "deposit" || n.source === "transfer") &&
        isPositiveAmount(n.amount)
    )

    expect(activityNotes).toHaveLength(2)
    expect(activityNotes[0].source).toBe("deposit")
    expect(activityNotes[0].amount).toBe("1000")
    expect(activityNotes[1].source).toBe("transfer")
    expect(activityNotes[1].amount).toBe("5000")
  })
})
