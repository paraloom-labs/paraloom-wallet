import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  _resetProverForTests,
  ensureInit,
  ensureReady,
  ensureTransactReady,
  ensureTransferReady
} from "../lib/prover/index"

const { mockInit } = vi.hoisted(() => ({ mockInit: vi.fn() }))

vi.mock("../lib/prover/paraloom_prover_wasm.js", () => ({
  default: mockInit,
  mint_to_asset: vi.fn(),
  note_commitment_v2: vi.fn(),
  prove_transact: vi.fn(),
  prove_transfer_v2: vi.fn(),
  prove_withdrawal_v2: vi.fn(),
  spend_pubkey: vi.fn(),
  v3_merkle_path: vi.fn(),
  v3_note_commitment: vi.fn(),
  v3_note_commitment_asset: vi.fn(),
  v3_note_pubkey: vi.fn()
}))

vi.mock("url:./paraloom_prover_wasm_bg.wasm", () => ({ default: "mock://wasm" }))
vi.mock("url:./withdraw_v2_proving.key", () => ({ default: "mock://withdraw_key" }))
vi.mock("url:./transfer_v2_proving.key", () => ({ default: "mock://transfer_key" }))
vi.mock("url:./transact_v3_proving.key", () => ({ default: "mock://transact_key" }))

describe("prover/index.ts initialization and key caching", () => {
  beforeEach(() => {
    _resetProverForTests()
    mockInit.mockReset()
    vi.restoreAllMocks()
  })

  it("races WASM init: concurrent calls to ensureInit share the same in-flight promise", async () => {
    let resolveInit: () => void = () => {}
    mockInit.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveInit = resolve
        })
    )

    // Trigger two concurrent ensureInit calls
    const p1 = ensureInit()
    const p2 = ensureInit()

    // mockInit should only be called once
    expect(mockInit).toHaveBeenCalledTimes(1)

    // Complete the init
    resolveInit()
    await Promise.all([p1, p2])

    // Further calls should return immediately without calling mockInit again
    await ensureInit()
    expect(mockInit).toHaveBeenCalledTimes(1)
  })

  it("does not permanently latch failed WASM init and allows retry", async () => {
    mockInit.mockRejectedValueOnce(new Error("WASM init failure"))

    await expect(ensureInit()).rejects.toThrow("WASM init failure")

    // After failure, next call retries
    mockInit.mockResolvedValueOnce(undefined)
    await expect(ensureInit()).resolves.toBeUndefined()
    expect(mockInit).toHaveBeenCalledTimes(2)
  })

  it("does not cache failed or empty key fetches (HTTP error or 0 bytes)", async () => {
    mockInit.mockResolvedValue(undefined)

    // First fetch fails with HTTP 404
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      arrayBuffer: async () => new ArrayBuffer(0)
    })
    globalThis.fetch = fetchMock

    await expect(ensureReady()).rejects.toThrow("failed to fetch withdrawal proving key: HTTP 404")

    // Second fetch returns 200 but 0 bytes (empty buffer)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0)
    })

    await expect(ensureReady()).rejects.toThrow("fetched withdrawal proving key is empty")

    // Third fetch succeeds with valid bytes
    const validKey = new Uint8Array([1, 2, 3, 4, 5])
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => validKey.buffer
    })

    const key = await ensureReady()
    expect(key).toEqual(validKey)

    // Subsequent call uses cached key without fetching again
    const keyCached = await ensureReady()
    expect(keyCached).toEqual(validKey)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("deduplicates concurrent key fetches for transfer and transact", async () => {
    mockInit.mockResolvedValue(undefined)

    const validTransferKey = new Uint8Array([10, 20, 30])
    let resolveFetch: (val: any) => void = () => {}

    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = () =>
            resolve({
              ok: true,
              status: 200,
              arrayBuffer: async () => validTransferKey.buffer
            })
        })
    )
    globalThis.fetch = fetchMock

    await ensureInit()

    const p1 = ensureTransferReady()
    const p2 = ensureTransferReady()

    // Let microtask tick to enter fetch
    await Promise.resolve()

    // Only one fetch was initiated
    expect(fetchMock).toHaveBeenCalledTimes(1)

    resolveFetch(null)
    const [k1, k2] = await Promise.all([p1, p2])
    expect(k1).toEqual(validTransferKey)
    expect(k2).toEqual(validTransferKey)
  })

  it("ensures transact ready handles failure and retries", async () => {
    mockInit.mockResolvedValue(undefined)

    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("Network drop"))
    globalThis.fetch = fetchMock

    await expect(ensureTransactReady()).rejects.toThrow("Network drop")

    const validTransactKey = new Uint8Array([99, 88])
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => validTransactKey.buffer
    })

    const key = await ensureTransactReady()
    expect(key).toEqual(validTransactKey)
  })
})
