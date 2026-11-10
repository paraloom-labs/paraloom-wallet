import { afterEach, describe, expect, it, vi } from "vitest"

const { mockInit, mockV3MerklePath } = vi.hoisted(() => ({
  mockInit: vi.fn().mockResolvedValue(undefined),
  mockV3MerklePath: vi.fn((_leavesJson: string, _leafIndex: number) =>
    JSON.stringify({ path: ["00".repeat(32)], root: "11".repeat(32) })
  )
}))

vi.mock("url:./paraloom_prover_wasm_bg.wasm", () => ({ default: "mock-wasm-url" }))
vi.mock("url:./withdraw_v2_proving.key", () => ({ default: "mock-withdraw-key-url" }))
vi.mock("url:./transfer_v2_proving.key", () => ({ default: "mock-transfer-key-url" }))
vi.mock("url:./transact_v3_proving.key", () => ({ default: "mock-transact-key-url" }))

vi.mock("../lib/prover/paraloom_prover_wasm.js", () => ({
  default: mockInit,
  mint_to_asset: vi.fn(),
  note_commitment_v2: vi.fn(),
  prove_transact: vi.fn(),
  prove_transfer_v2: vi.fn(),
  prove_withdrawal_v2: vi.fn(),
  spend_pubkey: vi.fn(),
  v3_merkle_path: mockV3MerklePath,
  v3_note_commitment: vi.fn(),
  v3_note_commitment_asset: vi.fn(),
  v3_note_pubkey: vi.fn()
}))

import {
  ensureInit,
  ensureReady,
  ensureTransactReady,
  ensureTransferReady,
  v3MerklePath
} from "../lib/prover/index"

describe("prover validation & deduplication (#263)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("v3MerklePath leafIndex & leavesHex validation", () => {
    it("rejects non-array or non-string leavesHex", async () => {
      await expect(v3MerklePath("not-array" as any, 0)).rejects.toThrow(
        "leavesHex must be an array of strings"
      )
      await expect(v3MerklePath([123 as any], 0)).rejects.toThrow(
        "leavesHex must be an array of strings"
      )
    })

    it("rejects negative leafIndex (no ToUint32 wrap)", async () => {
      await expect(v3MerklePath(["00".repeat(32)], -1)).rejects.toThrow(
        "Invalid leafIndex: must be an unsigned 32-bit integer"
      )
    })

    it("rejects non-safe-integer and non-u32 leafIndex", async () => {
      await expect(v3MerklePath(["00".repeat(32)], Number.NaN)).rejects.toThrow(
        "Invalid leafIndex"
      )
      await expect(v3MerklePath(["00".repeat(32)], 1.5)).rejects.toThrow(
        "Invalid leafIndex"
      )
      await expect(v3MerklePath(["00".repeat(32)], 0x1_0000_0000)).rejects.toThrow(
        "Invalid leafIndex"
      )
    })

    it("accepts valid leaves and leafIndex", async () => {
      const res = await v3MerklePath(["00".repeat(32), "11".repeat(32)], 1)
      expect(res).toEqual({ path: ["00".repeat(32)], root: "11".repeat(32) })
      expect(mockV3MerklePath).toHaveBeenCalledWith(
        JSON.stringify(["00".repeat(32), "11".repeat(32)]),
        1
      )
    })
  })

  describe("ensureInit concurrent deduplication", () => {
    it("deduplicates concurrent ensureInit calls returning the same in-flight promise", async () => {
      const p1 = ensureInit()
      const p2 = ensureInit()
      const p3 = ensureInit()
      expect(p1).toBe(p2)
      expect(p2).toBe(p3)
      await Promise.all([p1, p2, p3])
    })
  })

  describe("proving-key fetch status and empty buffer validation", () => {
    it("rejects on HTTP error and does not permanently cache invalid key", async () => {
      // First call fails with 500
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Server Error", { status: 500 })
      )
      await expect(ensureReady()).rejects.toThrow("Failed to fetch withdraw proving key: HTTP 500")

      // Subsequent call can retry and succeed with valid buffer
      const validKeyBytes = new Uint8Array([1, 2, 3, 4])
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(validKeyBytes, { status: 200 })
      )
      const key = await ensureReady()
      expect(key).toEqual(validKeyBytes)
    })

    it("rejects on empty key buffer", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(new Uint8Array(0), { status: 200 })
      )
      await expect(ensureTransferReady()).rejects.toThrow(
        "Failed to fetch transfer proving key: received empty key buffer"
      )
    })

    it("deduplicates concurrent key fetches", async () => {
      const transactBytes = new Uint8Array([5, 6, 7, 8])
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        return new Response(transactBytes, { status: 200 })
      })

      const [k1, k2] = await Promise.all([ensureTransactReady(), ensureTransactReady()])
      expect(k1).toEqual(transactBytes)
      expect(k2).toEqual(transactBytes)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  })
})
