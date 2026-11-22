// Ingress fetches must fail fast on a hung node (#303).
//
// `scanForNotes` and `submitTransact` used bare `fetch()` calls with no
// timeout, so a node that accepts the connection but never responds hangs
// the call forever. The scan hang is the sharper consequence: `backgroundScan`
// sets `scanInFlight = true` before awaiting the scan and only clears it in a
// `finally`, so one hung scan strands the background scanner for the rest of
// the service worker's life. Both functions now pass
// `AbortSignal.timeout(...)` (30 s by default, in line with the routing fetch
// in privateSwap), with the deadline overridable so tests can prove the
// timeout fires without waiting out the production value.
//
// The prover is mocked the way scan.test.ts mocks it: the wasm binary is a
// build input that is not in the repo. The abort path throws before any prover
// call, and the happy-path controls below only reach `v3NotePubkey`, so these
// stubs pin the control flow, not Poseidon.

import * as nacl from "tweetnacl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { scanForNotes } from "~lib/paraloom/scan"
import { submitTransact } from "~lib/paraloom/transact"
import { TRANSACT_INGRESS_TIMEOUT_MS } from "~lib/paraloom/constants"
import { installFakeChrome } from "./support/chromeStorage"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  assetIdForMint: vi.fn(async () => "00".repeat(32)),
  v3NoteCommitment: vi.fn(async () => "commitment"),
  v3NoteCommitmentAsset: vi.fn(async () => "commitment"),
  v3NotePubkey: vi.fn(async (privkeyHex: string) => `pub_${privkeyHex}`)
}))

const ACCOUNT = "paraloom1" + "11".repeat(64)
const SPEND_PRIVKEY = "ab".repeat(32)

const BUNDLE = JSON.stringify({
  nullifiers: ["00".repeat(32), "11".repeat(32)],
  output_commitments: ["22".repeat(32), "33".repeat(32)],
  proof: "proof-bytes"
})

/** What a real fetch rejects with when its signal aborts. */
function abortError() {
  return new DOMException("The operation was aborted.", "AbortError")
}

/**
 * A fetch stub that mimics a hung node: the promise never settles on its
 * own, but it honours the abort signal exactly the way real fetch does, so a
 * caller without a timeout hangs forever and a caller with one rejects.
 */
function hangForeverFetch() {
  const fetchMock = vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) return // never settles: no signal, no timeout
        if (signal.aborted) {
          reject(abortError())
          return
        }
        signal.addEventListener("abort", () => reject(abortError()), {
          once: true
        })
      })
  )
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

beforeEach(() => {
  installFakeChrome()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ingress fetch timeout (#303)", () => {
  it("defaults to 30 s, in line with the routing fetch", () => {
    expect(TRANSACT_INGRESS_TIMEOUT_MS).toBe(30_000)
  })

  it("scanForNotes rejects instead of hanging when the node never responds", async () => {
    const fetchMock = hangForeverFetch()
    const box = nacl.box.keyPair()
    const start = Date.now()
    await expect(
      scanForNotes(ACCOUNT, box.secretKey, SPEND_PRIVKEY, 25)
    ).rejects.toThrow(/abort/i)
    // Fails fast: the 25 ms deadline, not the 30 s default and not forever.
    expect(Date.now() - start).toBeLessThan(5_000)
    expect(fetchMock).toHaveBeenCalledOnce()
    const signal = fetchMock.mock.calls[0][1]?.signal as AbortSignal | undefined
    expect(signal?.aborted).toBe(true)
  })

  it("submitTransact rejects instead of hanging when the node never responds", async () => {
    const fetchMock = hangForeverFetch()
    const start = Date.now()
    await expect(
      submitTransact(
        "44".repeat(32),
        1000n,
        "55".repeat(32),
        BUNDLE,
        ["cipher0", "cipher1"],
        undefined,
        undefined,
        25
      )
    ).rejects.toThrow(/abort/i)
    expect(Date.now() - start).toBeLessThan(5_000)
    expect(fetchMock).toHaveBeenCalledOnce()
    const signal = fetchMock.mock.calls[0][1]?.signal as AbortSignal | undefined
    expect(signal?.aborted).toBe(true)
  })

  it("scanForNotes still resolves on a fast empty delivery (timeout is not a break)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => []
    }))
    vi.stubGlobal("fetch", fetchMock)
    const box = nacl.box.keyPair()
    await expect(
      scanForNotes(ACCOUNT, box.secretKey, SPEND_PRIVKEY, 25)
    ).resolves.toBe(0)
  })

  it("submitTransact still resolves on a fast response (timeout is not a break)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ request_id: "req-1" })
    }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(
      submitTransact(
        "44".repeat(32),
        1000n,
        "55".repeat(32),
        BUNDLE,
        ["cipher0", "cipher1"],
        undefined,
        undefined,
        25
      )
    ).resolves.toEqual({ requestId: "req-1" })
  })
})
