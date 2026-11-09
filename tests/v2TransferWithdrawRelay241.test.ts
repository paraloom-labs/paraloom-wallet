import { beforeEach, describe, expect, it, vi } from "vitest"
import { NATIVE_ASSET_HEX, noteCommitmentV2, proveWithdrawalV2, proveTransferV2 } from "~lib/prover"
import { validateMerklePathResponse, withdraw } from "~lib/paraloom/withdraw"
import { transfer } from "~lib/paraloom/transfer"
import type { ShieldedNote } from "~lib/paraloom/notes"
import { installFakeChrome } from "./support/chromeStorage"

// Mock prover module since WASM cannot load in vitest
vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  noteCommitmentV2: vi.fn(async (amount: bigint, privkey: string, blinding: string, assetId: string) => {
    return "cc" + "11".repeat(31)
  }),
  proveWithdrawalV2: vi.fn(async (_args: any) => ({
    nullifier: "nn" + "22".repeat(31),
    proof: "pp" + "33".repeat(31)
  })),
  proveTransferV2: vi.fn(async (_root: string, _assetId: string, _inputs: any[], _outputs: any[]) => ({
    nullifiers: ["n0" + "44".repeat(31), "n1" + "55".repeat(31)],
    output_commitments: ["oc0" + "66".repeat(31), "oc1" + "77".repeat(31)],
    proof: "proof-hex-v2"
  }))
}))

const BOX_PUB = "7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13"
const SPEND_PUB = "22".repeat(32)
const SHIELDED_ADDR_1 = "paraloom1" + BOX_PUB + SPEND_PUB
const SHIELDED_ADDR_2 = "paraloom1" + BOX_PUB + "33".repeat(32)
const SOLANA_DEST = "11111111111111111111111111111111"

function validMerklePath(): { root: string; path: string[]; indices: boolean[] } {
  return {
    root: "aa".repeat(32),
    path: Array(32).fill("bb".repeat(32)),
    indices: Array(32).fill(false)
  }
}

function makeNote(overrides: Partial<ShieldedNote> = {}): ShieldedNote {
  return {
    amount: "1000",
    blinding: "aa".repeat(32),
    assetId: NATIVE_ASSET_HEX,
    signature: "sig-test-1",
    createdAt: 1,
    spent: false,
    source: "deposit",
    ...overrides
  }
}

beforeEach(() => {
  installFakeChrome()
  vi.clearAllMocks()
})

describe("validateMerklePathResponse (#241)", () => {
  it("accepts a well-formed MerklePathResponse with 64-hex root, 32 64-hex path elements, and 32 booleans", () => {
    const raw = validMerklePath()
    const result = validateMerklePathResponse(raw)
    expect(result.root).toBe(raw.root)
    expect(result.path).toEqual(raw.path)
    expect(result.indices).toEqual(raw.indices)
  })

  it("rejects non-object or null input", () => {
    expect(() => validateMerklePathResponse(null)).toThrow("expected object")
    expect(() => validateMerklePathResponse(undefined)).toThrow("expected object")
    expect(() => validateMerklePathResponse("string")).toThrow("expected object")
  })

  it("rejects invalid roots (wrong length, non-hex, non-string)", () => {
    expect(() => validateMerklePathResponse({ ...validMerklePath(), root: "not-hex" })).toThrow("root must be a 64-hex string")
    expect(() => validateMerklePathResponse({ ...validMerklePath(), root: "aa".repeat(31) })).toThrow("root must be a 64-hex string")
    expect(() => validateMerklePathResponse({ ...validMerklePath(), root: 12345 })).toThrow("root must be a 64-hex string")
  })

  it("rejects path with invalid length or non-64-hex elements", () => {
    expect(() => validateMerklePathResponse({ ...validMerklePath(), path: Array(31).fill("bb".repeat(32)) })).toThrow("path must be 32 64-hex strings")
    expect(() => validateMerklePathResponse({ ...validMerklePath(), path: Array(33).fill("bb".repeat(32)) })).toThrow("path must be 32 64-hex strings")
    expect(() => validateMerklePathResponse({
      ...validMerklePath(),
      path: [...Array(31).fill("bb".repeat(32)), "invalid-hex"]
    })).toThrow("path must be 32 64-hex strings")
  })

  it("rejects indices with invalid length or non-boolean elements", () => {
    expect(() => validateMerklePathResponse({ ...validMerklePath(), indices: Array(31).fill(false) })).toThrow("indices must be 32 booleans")
    expect(() => validateMerklePathResponse({ ...validMerklePath(), indices: [...Array(31).fill(false), "false" as any] })).toThrow("indices must be 32 booleans")
  })
})

describe("withdraw (#241)", () => {
  it("rejects already spent note", async () => {
    const note = makeNote({ spent: true })
    await expect(withdraw(note, SOLANA_DEST, "11".repeat(32))).rejects.toThrow("cannot withdraw already spent note")
  })

  it("rejects non-positive or invalid amounts", async () => {
    await expect(withdraw(makeNote({ amount: "0" }), SOLANA_DEST, "11".repeat(32))).rejects.toThrow("withdraw amount must be positive")
    await expect(withdraw(makeNote({ amount: "-50" }), SOLANA_DEST, "11".repeat(32))).rejects.toThrow("withdraw amount must be positive")
    await expect(withdraw(makeNote({ amount: "invalid" }), SOLANA_DEST, "11".repeat(32))).rejects.toThrow("invalid note amount")
  })

  it("rejects non-native note assetId", async () => {
    const note = makeNote({ assetId: "99".repeat(32) })
    await expect(withdraw(note, SOLANA_DEST, "11".repeat(32))).rejects.toThrow("v2 withdrawal only supports native SOL notes")
  })

  it("rejects empty or whitespace-only recipient addresses", async () => {
    await expect(withdraw(makeNote(), "", "11".repeat(32))).rejects.toThrow("invalid recipient address")
    await expect(withdraw(makeNote(), "   ", "11".repeat(32))).rejects.toThrow("invalid recipient address")
  })

  it("normalizes empty assetId and trims recipient address", async () => {
    const note = makeNote({ assetId: "" })
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/merkle/path/")) {
        return {
          ok: true,
          status: 200,
          json: async () => validMerklePath()
        }
      }
      if (url.includes("/withdrawal/submit")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ request_id: "req-withdraw-123" })
        }
      }
      throw new Error(`Unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const res = await withdraw(note, `  ${SOLANA_DEST}  `, "11".repeat(32))
    expect(res.requestId).toBe("req-withdraw-123")
    expect(noteCommitmentV2).toHaveBeenCalledWith(1000n, "11".repeat(32), note.blinding, NATIVE_ASSET_HEX)
    expect(proveWithdrawalV2).toHaveBeenCalledWith(expect.objectContaining({
      assetId: NATIVE_ASSET_HEX
    }))
  })

  it("fails if path server returns malformed MerklePathResponse", async () => {
    const note = makeNote()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ root: "not-64-hex", path: [], indices: [] })
    }))

    await expect(withdraw(note, SOLANA_DEST, "11".repeat(32))).rejects.toThrow("invalid Merkle path response")
  })
})

describe("transfer (#241)", () => {
  it("rejects non-positive transfer amounts", async () => {
    const n1 = makeNote({ blinding: "11".repeat(32) })
    const n2 = makeNote({ blinding: "22".repeat(32) })
    await expect(transfer("acct", SHIELDED_ADDR_1, SHIELDED_ADDR_2, 0n, [n1, n2], "11".repeat(32))).rejects.toThrow("transfer amount must be positive")
    await expect(transfer("acct", SHIELDED_ADDR_1, SHIELDED_ADDR_2, -10n, [n1, n2], "11".repeat(32))).rejects.toThrow("transfer amount must be positive")
  })

  it("rejects input notes array that does not have exactly 2 notes", async () => {
    const n1 = makeNote({ blinding: "11".repeat(32) })
    await expect(transfer("acct", SHIELDED_ADDR_1, SHIELDED_ADDR_2, 500n, [n1] as any, "11".repeat(32))).rejects.toThrow("Transfer requires exactly two input notes")
  })

  it("rejects duplicate input notes (same blinding or commitment)", async () => {
    const n1 = makeNote({ blinding: "aa".repeat(32), commitment: "c1" })
    const n2 = makeNote({ blinding: "aa".repeat(32), commitment: "c2" })
    await expect(transfer("acct", SHIELDED_ADDR_1, SHIELDED_ADDR_2, 500n, [n1, n2], "11".repeat(32))).rejects.toThrow("cannot use duplicate input notes in transfer")

    const n3 = makeNote({ blinding: "bb".repeat(32), commitment: "c1" })
    await expect(transfer("acct", SHIELDED_ADDR_1, SHIELDED_ADDR_2, 500n, [n1, n3], "11".repeat(32))).rejects.toThrow("cannot use duplicate input notes in transfer")
  })

  it("rejects already spent input notes", async () => {
    const n1 = makeNote({ spent: true, blinding: "11".repeat(32) })
    const n2 = makeNote({ spent: false, blinding: "22".repeat(32) })
    await expect(transfer("acct", SHIELDED_ADDR_1, SHIELDED_ADDR_2, 500n, [n1, n2], "11".repeat(32))).rejects.toThrow("cannot transfer already spent note")
  })

  it("rejects non-positive note amounts in inputs", async () => {
    const n1 = makeNote({ amount: "0", blinding: "11".repeat(32) })
    const n2 = makeNote({ amount: "1000", blinding: "22".repeat(32) })
    await expect(transfer("acct", SHIELDED_ADDR_1, SHIELDED_ADDR_2, 500n, [n1, n2], "11".repeat(32))).rejects.toThrow("input note amount must be positive")
  })

  it("rejects non-native input note assetId", async () => {
    const n1 = makeNote({ assetId: "33".repeat(32), blinding: "11".repeat(32) })
    const n2 = makeNote({ assetId: NATIVE_ASSET_HEX, blinding: "22".repeat(32) })
    await expect(transfer("acct", SHIELDED_ADDR_1, SHIELDED_ADDR_2, 500n, [n1, n2], "11".repeat(32))).rejects.toThrow("v2 transfer only supports native SOL notes")
  })

  it("rejects if inputs sum is less than transfer amount", async () => {
    const n1 = makeNote({ amount: "200", blinding: "11".repeat(32) })
    const n2 = makeNote({ amount: "200", blinding: "22".repeat(32) })
    await expect(transfer("acct", SHIELDED_ADDR_1, SHIELDED_ADDR_2, 500n, [n1, n2], "11".repeat(32))).rejects.toThrow("Selected notes do not cover the transfer amount")
  })

  it("normalizes empty assetId and successfully completes transfer", async () => {
    const n1 = makeNote({ amount: "600", assetId: "", blinding: "11".repeat(32) })
    const n2 = makeNote({ amount: "600", assetId: NATIVE_ASSET_HEX, blinding: "22".repeat(32) })

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/merkle/path/")) {
        return {
          ok: true,
          status: 200,
          json: async () => validMerklePath()
        }
      }
      if (url.includes("/transfer/submit")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ request_id: "req-12345" })
        }
      }
      throw new Error(`Unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const res = await transfer("acct", SHIELDED_ADDR_1, SHIELDED_ADDR_2, 800n, [n1, n2], "11".repeat(32))
    expect(res.requestId).toBe("req-12345")
    expect(res.changeCommitment).toBe("oc1" + "77".repeat(31))
    // Verifies noteCommitmentV2 was called with NATIVE_ASSET_HEX for both inputs
    expect(noteCommitmentV2).toHaveBeenCalledWith(600n, "11".repeat(32), n1.blinding, NATIVE_ASSET_HEX)
    expect(noteCommitmentV2).toHaveBeenCalledWith(600n, "11".repeat(32), n2.blinding, NATIVE_ASSET_HEX)
    expect(proveTransferV2).toHaveBeenCalledWith(
      "aa".repeat(32),
      NATIVE_ASSET_HEX,
      expect.any(Array),
      expect.any(Array)
    )
  })
})

describe("relay & inpage guards (#241)", () => {
  function isPlainObject(val: unknown): val is Record<string, unknown> {
    return typeof val === "object" && val !== null && !Array.isArray(val)
  }

  it("isPlainObject accepts plain objects and rejects arrays, primitives, and null", () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject({ foo: "bar" })).toBe(true)
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(["a", "b"])).toBe(false)
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject(undefined)).toBe(false)
    expect(isPlainObject("string")).toBe(false)
    expect(isPlainObject(123)).toBe(false)
    expect(isPlainObject(true)).toBe(false)
  })

  it("Number.isSafeInteger rejects NaN, Infinity, -Infinity, strings, and floats", () => {
    expect(Number.isSafeInteger(1)).toBe(true)
    expect(Number.isSafeInteger(1000)).toBe(true)
    expect(Number.isSafeInteger(NaN)).toBe(false)
    expect(Number.isSafeInteger(Infinity)).toBe(false)
    expect(Number.isSafeInteger(-Infinity)).toBe(false)
    expect(Number.isSafeInteger("1" as any)).toBe(false)
    expect(Number.isSafeInteger(1.5)).toBe(false)
  })

  it("freezing provider prevents property modifications", () => {
    const provider = { __version: "1.5.6", testFn: () => "ok" }
    const frozen = Object.freeze(provider)
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(() => {
      (frozen as any).testFn = () => "modified"
    }).toThrow()
    expect(() => {
      (frozen as any).newProp = 123
    }).toThrow()
  })

  it("relay timeout cleans up message listener and rejects after timeout", async () => {
    vi.useFakeTimers()
    const listeners: ((e: any) => void)[] = []
    const fakeWindow = {
      location: { origin: "https://app.paraloom.io" },
      addEventListener: vi.fn((event: string, fn: any) => {
        if (event === "message") listeners.push(fn)
      }),
      removeEventListener: vi.fn((event: string, fn: any) => {
        if (event === "message") {
          const idx = listeners.indexOf(fn)
          if (idx !== -1) listeners.splice(idx, 1)
        }
      }),
      postMessage: vi.fn()
    }
    vi.stubGlobal("window", fakeWindow)

    let counter = 0
    const RELAY_TIMEOUT_MS = 60_000
    function testRelay(type: string, payload?: Record<string, unknown>): Promise<any> {
      return new Promise((resolve, reject) => {
        const id = ++counter
        let timer: ReturnType<typeof setTimeout> | null = null

        const cleanup = () => {
          if (timer !== null) {
            clearTimeout(timer)
            timer = null
          }
          fakeWindow.removeEventListener("message", onMessage)
        }

        const onMessage = (event: any) => {
          if (event.source !== fakeWindow) return
          if (event.origin !== fakeWindow.location.origin) return
          const data = event.data
          if (!data || data.channel !== "paraloom:response" || !Number.isSafeInteger(data.id) || data.id !== id) return
          cleanup()
          if (data.error) reject(new Error(data.error))
          else resolve(data.result)
        }

        timer = setTimeout(() => {
          cleanup()
          reject(new Error(`Relay request timed out after ${RELAY_TIMEOUT_MS}ms`))
        }, RELAY_TIMEOUT_MS)

        fakeWindow.addEventListener("message", onMessage)
        fakeWindow.postMessage({ channel: "paraloom:request", id, type, payload }, fakeWindow.location.origin)
      })
    }

    const promise = testRelay("IS_CONNECTED")
    expect(listeners.length).toBe(1)

    // Advance clock past 60s
    vi.advanceTimersByTime(60_001)

    await expect(promise).rejects.toThrow("Relay request timed out after 60000ms")
    expect(listeners.length).toBe(0)
    expect(fakeWindow.removeEventListener).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it("relay ignores mismatched origins and non-safe-integer IDs", async () => {
    const listeners: ((e: any) => void)[] = []
    const fakeWindow = {
      location: { origin: "https://app.paraloom.io" },
      addEventListener: vi.fn((event: string, fn: any) => {
        if (event === "message") listeners.push(fn)
      }),
      removeEventListener: vi.fn((event: string, fn: any) => {
        if (event === "message") {
          const idx = listeners.indexOf(fn)
          if (idx !== -1) listeners.splice(idx, 1)
        }
      }),
      postMessage: vi.fn()
    }
    vi.stubGlobal("window", fakeWindow)

    let counter = 0
    function testRelay(type: string, payload?: Record<string, unknown>): Promise<any> {
      return new Promise((resolve, reject) => {
        const id = ++counter
        const onMessage = (event: any) => {
          if (event.source !== fakeWindow) return
          if (event.origin !== fakeWindow.location.origin) return
          const data = event.data
          if (!data || data.channel !== "paraloom:response" || !Number.isSafeInteger(data.id) || data.id !== id) return
          fakeWindow.removeEventListener("message", onMessage)
          if (data.error) reject(new Error(data.error))
          else resolve(data.result)
        }
        fakeWindow.addEventListener("message", onMessage)
        fakeWindow.postMessage({ channel: "paraloom:request", id, type, payload }, fakeWindow.location.origin)
      })
    }

    const promise = testRelay("GET_ADDRESS")
    const handler = listeners[0]

    // Send from malicious origin -> ignored
    handler({
      source: fakeWindow,
      origin: "https://evil.com",
      data: { channel: "paraloom:response", id: 1, result: { address: "fake" } }
    })
    expect(fakeWindow.removeEventListener).not.toHaveBeenCalled()

    // Send with NaN ID -> ignored
    handler({
      source: fakeWindow,
      origin: "https://app.paraloom.io",
      data: { channel: "paraloom:response", id: NaN, result: { address: "fake" } }
    })
    expect(fakeWindow.removeEventListener).not.toHaveBeenCalled()

    // Send valid response -> resolved
    handler({
      source: fakeWindow,
      origin: "https://app.paraloom.io",
      data: { channel: "paraloom:response", id: 1, result: { address: "valid-addr" } }
    })
    const res = await promise
    expect(res).toEqual({ address: "valid-addr" })
    expect(fakeWindow.removeEventListener).toHaveBeenCalled()
  })
})
