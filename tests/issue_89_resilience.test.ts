import { describe, expect, it } from "vitest"
import { PublicKey } from "@solana/web3.js"

// Test base58Decode and buffer decoding directly
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

function base58Decode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0)
  const bytes: number[] = []
  for (const ch of s) {
    const v = B58_ALPHABET.indexOf(ch)
    if (v < 0) throw new Error(`invalid base58 char: ${ch}`)
    let carry = v
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  // preserve leading zero bytes (each leading '1' is a 0x00)
  for (let k = 0; k < s.length && s[k] === "1"; k++) bytes.push(0)
  return Uint8Array.from(bytes.reverse())
}

describe("Issue #89 Fixes: base58Decode & payload resilience", () => {
  it("base58Decode correctly decodes empty string as 0 bytes", () => {
    const res = base58Decode("")
    expect(res.length).toBe(0)
  })

  it("base58Decode correctly handles leading 1s without extra zero byte prepend", () => {
    const singleZero = base58Decode("1")
    expect(singleZero.length).toBe(1)
    expect(singleZero[0]).toBe(0)

    const threeZeros = base58Decode("111")
    expect(threeZeros.length).toBe(3)
    expect(Array.from(threeZeros)).toEqual([0, 0, 0])
  })

  it("base58Decode decodes known Solana public keys correctly", () => {
    const pkStr = "11111111111111111111111111111111"
    const decoded = base58Decode(pkStr)
    expect(decoded.length).toBe(32)
    expect(Array.from(decoded)).toEqual(new Array(32).fill(0))

    const sample = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
    const decodedSample = base58Decode(sample.toBase58())
    expect(decodedSample).toEqual(sample.toBytes())
  })
})
