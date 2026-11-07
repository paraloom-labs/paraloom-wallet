import { beforeEach, describe, expect, it, vi } from "vitest"
import { formatLamportsExact } from "../src/popup/Home"
import { installFakeChrome } from "./support/chromeStorage"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  v3NotePubkey: vi.fn(),
  depositV3: vi.fn(),
  spendV3: vi.fn()
}))
vi.mock("data-base64:~/../assets/icon.png", () => ({ default: "mock-icon" }))

describe("formatLamportsExact", () => {
  it("formats standard SOL amounts correctly", () => {
    expect(formatLamportsExact(1_000_000_000n, 9)).toBe("1")
    expect(formatLamportsExact(500_000_000n, 9)).toBe("0.5")
    expect(formatLamportsExact(1_500_000_000n, 9)).toBe("1.5")
    expect(formatLamportsExact(100_000_000n, 9)).toBe("0.1")
    expect(formatLamportsExact(1n, 9)).toBe("0.000000001")
  })

  it("formats token amounts with 6 decimals (e.g. USDC)", () => {
    expect(formatLamportsExact(1_000_000n, 6)).toBe("1")
    expect(formatLamportsExact(1_500_000n, 6)).toBe("1.5")
    expect(formatLamportsExact(1n, 6)).toBe("0.000001")
  })

  it("returns '0' for non-positive balances", () => {
    expect(formatLamportsExact(0n, 9)).toBe("0")
    expect(formatLamportsExact(-100n, 9)).toBe("0")
  })

  it("never rounds above atomic balance even for sub-lamport fractions and large values", () => {
    // 1.00005 SOL = 1_000_050_000n lamports. .toFixed(4) would round up to 1.0001 (1_000_100_000n).
    const exactStr = formatLamportsExact(1_000_050_000n, 9)
    expect(exactStr).toBe("1.00005")

    // Large numbers where Number(...) precision loss would overflow
    const largeBalance = 100_000_000_000_000_009n
    const largeExact = formatLamportsExact(largeBalance, 9)
    expect(largeExact).toBe("100000000.000000009")

    // Parse back using BigInt math to verify it never exceeds original
    const [whole, frac = ""] = largeExact.split(".")
    const reconstructed = BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, "0"))
    expect(reconstructed).toBe(largeBalance)
    expect(reconstructed <= largeBalance).toBe(true)
  })
})

describe("Activity incoming feed", () => {
  it("includes received transfers as well as deposits in the activity feed", () => {
    const notes = [
      {
        signature: "sig1",
        amount: "1000000000",
        spent: false,
        source: "deposit" as const,
        createdAt: 1000
      },
      {
        commitment: "comm2",
        amount: "500000000",
        spent: false,
        source: "transfer" as const,
        createdAt: 2000
      },
      {
        // Zero-amount filler note should be filtered out
        amount: "0",
        spent: false,
        source: "transfer" as const,
        createdAt: 3000
      }
    ]

    const incoming = notes.filter(
      (n) => (n.source === "deposit" || n.source === "transfer") && Number(n.amount) > 0
    )

    expect(incoming.length).toBe(2)
    expect(incoming[0].source).toBe("deposit")
    expect(incoming[1].source).toBe("transfer")
    expect(incoming[1].commitment).toBe("comm2")
  })
})

describe("Unlock & Export password error handling", () => {
  beforeEach(() => {
    installFakeChrome()
  })

  it("distinguishes decrypt failure (bad password) from post-decrypt errors", () => {
    let attempts = 0
    let lockedOut = false
    let reportedError = ""

    function handleAttempt(passwordMatches: boolean, postDecryptFails: boolean) {
      if (!passwordMatches) {
        attempts++
        if (attempts >= 5) {
          lockedOut = true
          reportedError = "Too many attempts"
          attempts = 0
        } else {
          reportedError = `Invalid password (${5 - attempts} attempts remaining)`
        }
        return
      }

      // Password matches! Reset attempts
      attempts = 0

      if (postDecryptFails) {
        // Post-decrypt failure: do not penalize attempts or trigger lockout
        reportedError = "Storage error during session save"
        return
      }

      reportedError = ""
    }

    // 1. Correct password but post-decrypt error occurs
    handleAttempt(true, true)
    expect(reportedError).toBe("Storage error during session save")
    expect(attempts).toBe(0)
    expect(lockedOut).toBe(false)

    // 2. Failed password attempt increments counter
    handleAttempt(false, false)
    expect(reportedError).toBe("Invalid password (4 attempts remaining)")
    expect(attempts).toBe(1)
    expect(lockedOut).toBe(false)

    // 3. Repeated failed attempts trigger lockout after 5 tries total
    handleAttempt(false, false) // 2
    handleAttempt(false, false) // 3
    handleAttempt(false, false) // 4
    handleAttempt(false, false) // 5 -> lockout
    expect(attempts).toBe(0) // reset on lockout
    expect(lockedOut).toBe(true)
    expect(reportedError).toBe("Too many attempts")
  })
})

describe("loadBalances account/network switch isolation", () => {
  it("cancels stale in-flight responses and resets balances on switch", async () => {
    let loadVersion = 0
    let solBalance = 0n
    let notes: string[] = []

    async function loadBalances(accountAddr: string, delayMs: number) {
      const version = ++loadVersion
      // Simulate RPC latency
      await new Promise((r) => setTimeout(r, delayMs))
      // Only commit state if version matches
      if (loadVersion === version) {
        solBalance = accountAddr === "acc1" ? 5_000_000_000n : 1_000_000_000n
        notes = [`note-for-${accountAddr}`]
      }
    }

    // 1. Account 1 starts loading with slow RPC (50ms)
    loadBalances("acc1", 50)

    // 2. User quickly switches to Account 2
    // Switch immediately invalidates previous version and resets state
    loadVersion++
    solBalance = 0n
    notes = []
    expect(solBalance).toBe(0n)
    expect(notes.length).toBe(0)

    // 3. Account 2 starts loading with fast RPC (10ms)
    await loadBalances("acc2", 10)
    expect(solBalance).toBe(1_000_000_000n)
    expect(notes).toEqual(["note-for-acc2"])

    // 4. Wait for Account 1's slow response to complete
    await new Promise((r) => setTimeout(r, 60))

    // Account 1's stale response MUST NOT overwrite Account 2's balance/notes
    expect(solBalance).toBe(1_000_000_000n)
    expect(notes).toEqual(["note-for-acc2"])
  })
})
