// Reproducer for the Number() truncation bug in submitTransact and withdraw.
//
// Both submitTransact (transact.ts:298) and withdraw (withdraw.ts:67) convert a
// bigint amount to a JSON number via Number(). JavaScript's Number is an IEEE-754
// double with only 53 bits of integer precision; any lamport value above 2^53 - 1
// (≈ 9,007,199 SOL) loses precision silently. In a financial system this is
// unacceptable — a rounding error in the ext_amount could cause a proof to verify
// against a different value than intended, or the ingress to credit the wrong
// amount.
//
// The fix is to send these values as strings in the JSON body, which preserves
// arbitrary precision and is the standard pattern for bigint-over-JSON in Solana
// and Ethereum tooling. The ingress server must parse the string (serde handles
// both number and string representations of u64/i128).

import { describe, expect, it } from "vitest"

// The exact threshold: Number.MAX_SAFE_INTEGER = 2^53 - 1.
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER) // 9_007_199_254_740_991n

describe("bigint → Number() precision loss (transact ext_amount / withdraw amount)", () => {
  it("Number() is lossless at MAX_SAFE_INTEGER", () => {
    expect(Number(MAX_SAFE)).toBe(Number.MAX_SAFE_INTEGER)
    expect(BigInt(Number(MAX_SAFE))).toBe(MAX_SAFE)
  })

  it("BUG: Number() silently loses precision above MAX_SAFE_INTEGER", () => {
    // 2^53 + 1 is the first integer that a 64-bit double cannot represent
    // exactly; Number() rounds it to 2^53, corrupting the value silently.
    const big = MAX_SAFE + 2n // 9_007_199_254_740_993n
    const asNum = Number(big)
    // Round-trip back to bigint yields a DIFFERENT value → silent data corruption.
    expect(BigInt(asNum)).not.toBe(big) // This is the bug.
  })

  it("BUG: negative bigint (ext_amount for withdraw) also loses precision", () => {
    const negBig = -(MAX_SAFE + 2n) // -9_007_199_254_740_993n
    const asNum = Number(negBig)
    expect(BigInt(asNum)).not.toBe(negBig) // The bug on the negative side.
  })

  it("FIX: toString() preserves full precision for any bigint", () => {
    const big = MAX_SAFE + 1n
    const asStr = big.toString()
    expect(BigInt(asStr)).toBe(big)

    const negBig = -(MAX_SAFE + 2n)
    const negStr = negBig.toString()
    expect(BigInt(negStr)).toBe(negBig)
  })

  it("FIX: typical lamport amounts are within safe range (sanity)", () => {
    // 1 SOL = 1_000_000_000 lamports; 1,000,000 SOL = 1e15 lamports.
    // These are well below MAX_SAFE_INTEGER and both paths agree.
    const typicalLamports = 1_000_000_000_000_000n
    expect(BigInt(Number(typicalLamports))).toBe(typicalLamports) // safe today
    expect(BigInt(typicalLamports.toString())).toBe(typicalLamports) // always safe
  })
})
