import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { submitTransact } from "~lib/paraloom/transact"

// transact.ts reaches ~lib/prover through bridge.ts; the wasm module cannot
// load under vitest and nothing in submitTransact uses it.
vi.mock("~lib/prover", () => ({ NATIVE_ASSET_HEX: "00".repeat(32) }))

const BUNDLE = JSON.stringify({
  nullifiers: ["11".repeat(32), "22".repeat(32)],
  output_commitments: ["33".repeat(32), "44".repeat(32)],
  proof: "55".repeat(96)
})

let rawBody: string | null

beforeEach(() => {
  rawBody = null
  global.fetch = vi.fn(async (_url: unknown, options: { body: string }) => {
    rawBody = options.body
    return {
      ok: true,
      json: async () => ({ request_id: "req_1" })
    }
  }) as never
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function submit(extAmount: bigint) {
  const res = await submitTransact(
    "00".repeat(32),
    extAmount,
    "aa".repeat(32),
    BUNDLE,
    ["ct0", "ct1"]
  )
  expect(res.requestId).toBe("req_1")
  return rawBody!
}

describe("submitTransact ext_amount serialization (#121)", () => {
  it("keeps ordinary amounts byte-identical to the previous Number() payload", async () => {
    const body = await submit(-5_000_000n)
    expect(body).toContain('"ext_amount":-5000000')
    // Still a JSON number, not a string — the ingress field is a typed i64.
    expect(body).not.toContain('"ext_amount":"')
  })

  it("serializes amounts above 2^53 exactly instead of rounding them", async () => {
    // 2^53 + 1 is the smallest positive integer a double cannot represent:
    // Number(9007199254740993n) === 9007199254740992.
    const body = await submit(9_007_199_254_740_993n)
    expect(body).toContain('"ext_amount":9007199254740993')
    expect(body).not.toContain("9007199254740992")
  })

  it("serializes large negative amounts exactly", async () => {
    const body = await submit(-9_007_199_254_740_993n)
    expect(body).toContain('"ext_amount":-9007199254740993')
  })

  it("accepts the full i64 range the proof binds", async () => {
    const max = await submit(9_223_372_036_854_775_807n)
    expect(max).toContain('"ext_amount":9223372036854775807')
    const min = await submit(-9_223_372_036_854_775_808n)
    expect(min).toContain('"ext_amount":-9223372036854775808')
  })

  it("rejects amounts outside the i64 range instead of emitting a corrupt payload", async () => {
    await expect(
      submitTransact("00".repeat(32), 9_223_372_036_854_775_808n, "aa".repeat(32), BUNDLE, [
        "ct0",
        "ct1"
      ])
    ).rejects.toThrow(/outside the i64 range/)
    expect(rawBody).toBeNull()
  })
})
