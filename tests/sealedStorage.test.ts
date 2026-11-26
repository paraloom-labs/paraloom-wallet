import { deriveSealingKey, isSealedBlob, sealJson, unsealJson } from "~lib/storage/sealed"
import { describe, expect, it } from "vitest"

const KEY_A = new Uint8Array(32).fill(1)
const KEY_B = new Uint8Array(32).fill(2)

describe("sealJson / unsealJson", () => {
  it("round-trips a JSON value", () => {
    const blob = sealJson({ a: [1, 2], b: "x" }, KEY_A)
    expect(unsealJson(blob, KEY_A)).toEqual({ a: [1, 2], b: "x" })
  })

  it("seals the same value differently every time (fresh nonce)", () => {
    expect(sealJson("same", KEY_A)).not.toBe(sealJson("same", KEY_A))
  })

  it("fails authentication under the wrong key", () => {
    const blob = sealJson("secret", KEY_A)
    expect(() => unsealJson(blob, KEY_B)).toThrow(/authentication/)
  })

  it("rejects tampered ciphertext", () => {
    const blob = sealJson("secret", KEY_A)
    const tampered = blob.slice(0, -2) + (blob.endsWith("00") ? "11" : "00")
    expect(() => unsealJson(tampered, KEY_A)).toThrow(/authentication/)
  })

  it("rejects non-blobs", () => {
    expect(() => unsealJson("plaintext", KEY_A)).toThrow(/not a sealed blob/)
    expect(isSealedBlob("plaintext")).toBe(false)
    expect(isSealedBlob(["not", "a", "string"])).toBe(false)
    expect(isSealedBlob(sealJson("x", KEY_A))).toBe(true)
  })
})

describe("deriveSealingKey", () => {
  it("is deterministic for one wallet and distinct per wallet", () => {
    const secret = new Uint8Array(64).fill(7)
    expect(deriveSealingKey(secret)).toEqual(deriveSealingKey(secret))
    expect(deriveSealingKey(secret)).not.toEqual(deriveSealingKey(new Uint8Array(64).fill(8)))
  })

  it("depends only on the account seed (first 32 bytes), not the pubkey half", () => {
    const a = new Uint8Array(64).fill(7)
    const b = new Uint8Array(64).fill(7)
    b.fill(99, 32) // different pubkey half, same seed
    expect(deriveSealingKey(a)).toEqual(deriveSealingKey(b))
  })
})
