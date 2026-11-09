import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({ NATIVE_ASSET_HEX: "00".repeat(32) }))

import { submitTransact } from "../lib/paraloom/transact"

const VALID_64_HEX_1 = "11".repeat(32)
const VALID_64_HEX_2 = "22".repeat(32)
const VALID_64_HEX_3 = "33".repeat(32)
const VALID_64_HEX_4 = "44".repeat(32)

function makeValidBundle(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    nullifiers: [VALID_64_HEX_1, VALID_64_HEX_2],
    output_commitments: [VALID_64_HEX_3, VALID_64_HEX_4],
    proof: "deadbeefcafebabe",
    ...overrides
  })
}

describe("submitTransact validation (#263)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("validates rootHex, recipientHex, and extAmount bounds", async () => {
    const validBundle = makeValidBundle()
    const validCiphertexts: [string, string] = ["0123", "4567"]

    // rootHex must be 64-char hex
    await expect(
      submitTransact(
        "tooshort",
        0n,
        VALID_64_HEX_1,
        validBundle,
        validCiphertexts
      )
    ).rejects.toThrow("Invalid rootHex")

    // recipientHex must be 64-char hex
    await expect(
      submitTransact(
        VALID_64_HEX_1,
        0n,
        "nothex".repeat(10),
        validBundle,
        validCiphertexts
      )
    ).rejects.toThrow("Invalid recipientHex")

    // extAmount must be <= 0n
    await expect(
      submitTransact(
        VALID_64_HEX_1,
        1n,
        VALID_64_HEX_2,
        validBundle,
        validCiphertexts
      )
    ).rejects.toThrow("Invalid extAmount")

    await expect(
      submitTransact(
        VALID_64_HEX_1,
        1000n,
        VALID_64_HEX_2,
        validBundle,
        validCiphertexts
      )
    ).rejects.toThrow("Invalid extAmount")
  })

  it("validates mintHex when provided", async () => {
    const validBundle = makeValidBundle()
    const validCiphertexts: [string, string] = ["0123", "4567"]

    await expect(
      submitTransact(
        VALID_64_HEX_1,
        0n,
        VALID_64_HEX_2,
        validBundle,
        validCiphertexts,
        undefined,
        "invalidmint"
      )
    ).rejects.toThrow("Invalid mintHex")
  })

  it("validates ciphertexts tuple", async () => {
    const validBundle = makeValidBundle()

    await expect(
      submitTransact(
        VALID_64_HEX_1,
        0n,
        VALID_64_HEX_2,
        validBundle,
        ["", ""] as any
      )
    ).rejects.toThrow("Invalid ciphertexts")

    await expect(
      submitTransact(
        VALID_64_HEX_1,
        0n,
        VALID_64_HEX_2,
        validBundle,
        ["onlyone"] as any
      )
    ).rejects.toThrow("Invalid ciphertexts")

    await expect(
      submitTransact(
        VALID_64_HEX_1,
        0n,
        VALID_64_HEX_2,
        validBundle,
        ["not_hex_!", "1234"] as any
      )
    ).rejects.toThrow("Invalid ciphertexts")
  })

  it("validates proofBundleJson structure and distinct nullifiers/commitments", async () => {
    const validCiphertexts: [string, string] = ["0123", "4567"]

    // Malformed JSON
    await expect(
      submitTransact(
        VALID_64_HEX_1,
        0n,
        VALID_64_HEX_2,
        "not json",
        validCiphertexts
      )
    ).rejects.toThrow("Invalid proofBundleJson")

    // Duplicate nullifiers
    await expect(
      submitTransact(
        VALID_64_HEX_1,
        0n,
        VALID_64_HEX_2,
        makeValidBundle({ nullifiers: [VALID_64_HEX_1, VALID_64_HEX_1] }),
        validCiphertexts
      )
    ).rejects.toThrow("nullifiers must be distinct")

    // Duplicate output commitments
    await expect(
      submitTransact(
        VALID_64_HEX_1,
        0n,
        VALID_64_HEX_2,
        makeValidBundle({ output_commitments: [VALID_64_HEX_3, VALID_64_HEX_3] }),
        validCiphertexts
      )
    ).rejects.toThrow("commitments must be distinct")

    // Empty or non-hex proof
    await expect(
      submitTransact(
        VALID_64_HEX_1,
        0n,
        VALID_64_HEX_2,
        makeValidBundle({ proof: "" }),
        validCiphertexts
      )
    ).rejects.toThrow("Invalid proof")

    await expect(
      submitTransact(
        VALID_64_HEX_1,
        0n,
        VALID_64_HEX_2,
        makeValidBundle({ proof: "not-hex!" }),
        validCiphertexts
      )
    ).rejects.toThrow("Invalid proof")
  })

  it("validates ingress response requestId", async () => {
    const validBundle = makeValidBundle()
    const validCiphertexts: [string, string] = ["0123", "4567"]

    // Mock fetch returning 200 without request_id or requestId
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "ok" }), { status: 200 })
    )

    await expect(
      submitTransact(
        VALID_64_HEX_1,
        0n,
        VALID_64_HEX_2,
        validBundle,
        validCiphertexts
      )
    ).rejects.toThrow("Invalid ingress response: missing or empty requestId")

    // Mock fetch returning 200 with empty string request_id
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ request_id: "   " }), { status: 200 })
    )

    await expect(
      submitTransact(
        VALID_64_HEX_1,
        0n,
        VALID_64_HEX_2,
        validBundle,
        validCiphertexts
      )
    ).rejects.toThrow("Invalid ingress response: missing or empty requestId")

    // Mock fetch returning valid request_id
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ request_id: "req_1234567890abcdef" }), {
        status: 200
      })
    )

    const result = await submitTransact(
      VALID_64_HEX_1,
      -5000n,
      VALID_64_HEX_2,
      validBundle,
      validCiphertexts
    )
    expect(result).toEqual({ requestId: "req_1234567890abcdef" })
  })
})
