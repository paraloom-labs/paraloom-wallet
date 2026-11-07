import { Keypair, PublicKey } from "@solana/web3.js"
import { describe, expect, it, vi } from "vitest"
import { buildDepositInstruction, buildDepositSplInstruction } from "../lib/paraloom/bridge"
import { depositNoteInstruction, submitTransact } from "../lib/paraloom/transact"

// Mock ~lib/prover to avoid wasm loader issues
vi.mock("~lib/prover", () => ({ NATIVE_ASSET_HEX: "00".repeat(32) }))

describe("bridge.ts and transact.ts u64 bounds and short pubkey/blinding checks", () => {
  const dummyPubkey = new PublicKey(new Uint8Array(32).fill(1))
  const valid32BytesA = new Uint8Array(32).fill(2)
  const valid32BytesB = new Uint8Array(32).fill(3)

  describe("buildDepositInstruction", () => {
    it("throws on non-bigint, 0, negative, or wrapping > u64 amounts", () => {
      expect(() => buildDepositInstruction(dummyPubkey, 0n, valid32BytesA, valid32BytesB)).toThrow(
        "amountLamports must be a positive u64 integer"
      )

      expect(() => buildDepositInstruction(dummyPubkey, -1n, valid32BytesA, valid32BytesB)).toThrow(
        "amountLamports must be a positive u64 integer"
      )

      expect(() =>
        buildDepositInstruction(dummyPubkey, 2n ** 64n, valid32BytesA, valid32BytesB)
      ).toThrow("amountLamports must be a positive u64 integer")

      expect(() =>
        buildDepositInstruction(dummyPubkey, 0x1_0000_0000_0000_0005n, valid32BytesA, valid32BytesB)
      ).toThrow("amountLamports must be a positive u64 integer")
    })

    it("throws on short, long, or non-Uint8Array recipient and randomness", () => {
      const short16 = new Uint8Array(16).fill(1)
      const long33 = new Uint8Array(33).fill(1)

      expect(() => buildDepositInstruction(dummyPubkey, 1000n, short16, valid32BytesB)).toThrow(
        "recipient must be a 32-byte Uint8Array"
      )

      expect(() => buildDepositInstruction(dummyPubkey, 1000n, long33, valid32BytesB)).toThrow(
        "recipient must be a 32-byte Uint8Array"
      )

      expect(() => buildDepositInstruction(dummyPubkey, 1000n, valid32BytesA, short16)).toThrow(
        "randomness must be a 32-byte Uint8Array"
      )

      expect(() => buildDepositInstruction(dummyPubkey, 1000n, null as any, valid32BytesB)).toThrow(
        "recipient must be a 32-byte Uint8Array"
      )
    })

    it("succeeds with valid u64 amount and 32-byte buffers without zero-padding", () => {
      const ix = buildDepositInstruction(dummyPubkey, 1_000_000n, valid32BytesA, valid32BytesB)
      expect(ix.data.length).toBe(80)
      const dv = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength)
      expect(dv.getBigUint64(8, true)).toBe(1_000_000n)
      expect(Uint8Array.from(ix.data.subarray(16, 48))).toEqual(valid32BytesA)
      expect(Uint8Array.from(ix.data.subarray(48, 80))).toEqual(valid32BytesB)
    })
  })

  describe("buildDepositSplInstruction", () => {
    it("throws on non-bigint, 0, negative, or wrapping > u64 amounts", () => {
      expect(() =>
        buildDepositSplInstruction(
          dummyPubkey,
          dummyPubkey,
          dummyPubkey,
          0n,
          valid32BytesA,
          valid32BytesB
        )
      ).toThrow("amount must be a positive u64 integer")

      expect(() =>
        buildDepositSplInstruction(
          dummyPubkey,
          dummyPubkey,
          dummyPubkey,
          -500n,
          valid32BytesA,
          valid32BytesB
        )
      ).toThrow("amount must be a positive u64 integer")

      expect(() =>
        buildDepositSplInstruction(
          dummyPubkey,
          dummyPubkey,
          dummyPubkey,
          2n ** 64n,
          valid32BytesA,
          valid32BytesB
        )
      ).toThrow("amount must be a positive u64 integer")
    })

    it("throws on short or non-Uint8Array pubkey and blinding", () => {
      const short20 = new Uint8Array(20).fill(9)

      expect(() =>
        buildDepositSplInstruction(
          dummyPubkey,
          dummyPubkey,
          dummyPubkey,
          5000n,
          short20,
          valid32BytesB
        )
      ).toThrow("pubkey must be a 32-byte Uint8Array")

      expect(() =>
        buildDepositSplInstruction(
          dummyPubkey,
          dummyPubkey,
          dummyPubkey,
          5000n,
          valid32BytesA,
          short20
        )
      ).toThrow("blinding must be a 32-byte Uint8Array")
    })

    it("succeeds with valid u64 amount and 32-byte buffers", () => {
      const ix = buildDepositSplInstruction(
        dummyPubkey,
        dummyPubkey,
        dummyPubkey,
        5000n,
        valid32BytesA,
        valid32BytesB
      )
      expect(ix.data.length).toBe(80)
      const dv = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength)
      expect(dv.getBigUint64(8, true)).toBe(5000n)
      expect(Uint8Array.from(ix.data.subarray(16, 48))).toEqual(valid32BytesA)
      expect(Uint8Array.from(ix.data.subarray(48, 80))).toEqual(valid32BytesB)
    })
  })

  describe("depositNoteInstruction", () => {
    it("throws on 0, negative, or wrapping > u64 amounts", () => {
      expect(() => depositNoteInstruction(dummyPubkey, 0n, valid32BytesA, valid32BytesB)).toThrow(
        "amountLamports must be a positive u64 integer"
      )

      expect(() => depositNoteInstruction(dummyPubkey, -1n, valid32BytesA, valid32BytesB)).toThrow(
        "amountLamports must be a positive u64 integer"
      )

      expect(() =>
        depositNoteInstruction(dummyPubkey, 2n ** 64n + 1n, valid32BytesA, valid32BytesB)
      ).toThrow("amountLamports must be a positive u64 integer")
    })

    it("throws on short pubkey or blinding", () => {
      const short24 = new Uint8Array(24).fill(7)
      expect(() => depositNoteInstruction(dummyPubkey, 10_000n, short24, valid32BytesB)).toThrow(
        "pubkey must be a 32-byte Uint8Array"
      )

      expect(() => depositNoteInstruction(dummyPubkey, 10_000n, valid32BytesA, short24)).toThrow(
        "blinding must be a 32-byte Uint8Array"
      )
    })

    it("succeeds with valid u64 amount and 32-byte buffers", () => {
      const ix = depositNoteInstruction(dummyPubkey, 999_999n, valid32BytesA, valid32BytesB)
      expect(ix.data.length).toBe(80)
      const dv = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength)
      expect(dv.getBigUint64(8, true)).toBe(999_999n)
      expect(Uint8Array.from(ix.data.subarray(16, 48))).toEqual(valid32BytesA)
      expect(Uint8Array.from(ix.data.subarray(48, 80))).toEqual(valid32BytesB)
    })
  })
})

describe("submitTransact proof bundle and requestId validation", () => {
  const validBundle = JSON.stringify({
    nullifiers: ["nf1_hex", "nf2_hex"],
    output_commitments: ["oc1_hex", "oc2_hex"],
    proof: "proof_hex_string"
  })

  it("throws on invalid proofBundleJson", async () => {
    await expect(
      submitTransact("root", 0n, "recip", "not a json string", ["ctx1", "ctx2"])
    ).rejects.toThrow("invalid proof bundle JSON")

    await expect(submitTransact("root", 0n, "recip", "null", ["ctx1", "ctx2"])).rejects.toThrow(
      "invalid proof bundle: must be an object"
    )

    await expect(
      submitTransact(
        "root",
        0n,
        "recip",
        JSON.stringify({ nullifiers: ["nf1"], output_commitments: ["oc1", "oc2"], proof: "p" }),
        ["ctx1", "ctx2"]
      )
    ).rejects.toThrow("nullifiers must be an array of 2 non-empty strings")

    await expect(
      submitTransact(
        "root",
        0n,
        "recip",
        JSON.stringify({ nullifiers: ["nf1", "nf2"], output_commitments: ["oc1"], proof: "p" }),
        ["ctx1", "ctx2"]
      )
    ).rejects.toThrow("output_commitments must be an array of 2 non-empty strings")

    await expect(
      submitTransact(
        "root",
        0n,
        "recip",
        JSON.stringify({
          nullifiers: ["nf1", "nf2"],
          output_commitments: ["oc1", "oc2"],
          proof: ""
        }),
        ["ctx1", "ctx2"]
      )
    ).rejects.toThrow("proof must be a non-empty string or object")
  })

  it("throws on HTTP error from transact ingress", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "bad request"
    })

    await expect(
      submitTransact("root", 0n, "recip", validBundle, ["ctx1", "ctx2"])
    ).rejects.toThrow("transact ingress rejected: 400 bad request")
  })

  it("throws when ingress returns missing or non-string requestId", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({})
    })

    await expect(
      submitTransact("root", 0n, "recip", validBundle, ["ctx1", "ctx2"])
    ).rejects.toThrow("transact ingress did not return a valid request ID")

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ request_id: "   " })
    })

    await expect(
      submitTransact("root", 0n, "recip", validBundle, ["ctx1", "ctx2"])
    ).rejects.toThrow("transact ingress did not return a valid request ID")
  })

  it("succeeds and extracts requestId from request_id or requestId", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ request_id: "req_12345" })
    })

    const res1 = await submitTransact("root", 0n, "recip", validBundle, ["ctx1", "ctx2"])
    expect(res1.requestId).toBe("req_12345")

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ requestId: "req_camel_case" })
    })

    const res2 = await submitTransact("root", 0n, "recip", validBundle, ["ctx1", "ctx2"])
    expect(res2.requestId).toBe("req_camel_case")
  })
})
