import type { Connection } from "@solana/web3.js"
import {
  DEPOSIT_NOTE_EVENT_DISCRIMINATOR,
  PATH_SERVER_URL,
  PROGRAM_ID,
  TRANSACT_EVENT_DISCRIMINATOR,
  TRANSFER_INGRESS_URL
} from "~lib/paraloom/constants"
import { tryDecryptNote } from "~lib/paraloom/noteCrypto"
import {
  addDiscoveredNote,
  addNote,
  getNotes,
  shieldedBalance,
  type ShieldedNote
} from "~lib/paraloom/notes"
import { transfer } from "~lib/paraloom/transfer"
import * as nacl from "tweetnacl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installFakeChrome } from "./support/chromeStorage"

const { noteCommitmentV2, proveTransferV2 } = vi.hoisted(() => {
  return {
    noteCommitmentV2: vi.fn(
      async (amount: bigint, privkeyHex: string, blindingHex: string, assetIdHex: string) =>
        `cm_${amount.toString(16)}_${privkeyHex.slice(0, 8)}_${blindingHex.slice(0, 8)}_${assetIdHex.slice(0, 8)}`
    ),
    proveTransferV2: vi.fn(
      async (
        _root: string,
        _assetIdHex: string,
        _inputs: unknown[],
        outputs: { amount: number; blinding_hex: string; pubkey_hex: string }[]
      ) => ({
        nullifiers: ["aa".repeat(32), "bb".repeat(32)],
        output_commitments: [
          `out0_${outputs[0].amount}_${outputs[0].pubkey_hex.slice(0, 8)}`,
          `out1_${outputs[1].amount}_${outputs[1].pubkey_hex.slice(0, 8)}`
        ],
        proof: "deadbeef"
      })
    )
  }
})

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  noteCommitmentV2,
  proveTransferV2
}))

const SPEND_PRIVKEY = "12".repeat(32)
const OWN_SPEND_PUB = "34".repeat(32)
const RECIPIENT_SPEND_PUB = "56".repeat(32)
const ASSET = "00".repeat(32)
const ROOT_A = "a1".repeat(32)
const ROOT_B = "b2".repeat(32)

let ownBox: nacl.BoxKeyPair
let recipientBox: nacl.BoxKeyPair
let ownShielded: string
let recipientShielded: string

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex")
}

function depositNote(amount: string, sig: string, blindingByte: string): ShieldedNote {
  return {
    amount,
    blinding: blindingByte.repeat(32),
    assetId: ASSET,
    signature: sig,
    createdAt: 1,
    spent: false,
    source: "deposit"
  }
}

function receivedNote(amount: string, commitment: string, blindingByte: string): ShieldedNote {
  return {
    amount,
    blinding: blindingByte.repeat(32),
    assetId: ASSET,
    signature: "",
    createdAt: 2,
    spent: false,
    commitment,
    source: "transfer"
  }
}

function fakeClock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    }
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  })
}

function payload(discriminator: Uint8Array, body: Uint8Array): string {
  const out = new Uint8Array(8 + body.length)
  out.set(discriminator, 0)
  out.set(body, 8)
  return Buffer.from(out).toString("base64")
}

function depositEvent(commitmentHex: string, leafIndex: number): string {
  const body = new Uint8Array(88)
  body.set(Buffer.from(commitmentHex, "hex"), 40)
  const view = new DataView(body.buffer)
  view.setBigUint64(72, BigInt(leafIndex), true)
  view.setBigInt64(80, 1_700_000_000n, true)
  return payload(DEPOSIT_NOTE_EVENT_DISCRIMINATOR, body)
}

function transactEvent(oc0Hex: string, oc1Hex: string): string {
  const body = new Uint8Array(224)
  body.set(Buffer.from(oc0Hex, "hex"), 64)
  body.set(Buffer.from(oc1Hex, "hex"), 96)
  return payload(TRANSACT_EVENT_DISCRIMINATOR, body)
}

function emittedBy(programId: string, ...events: string[]): string[] {
  return [
    `Program ${programId} invoke [1]`,
    ...events.map((e) => `Program data: ${e}`),
    `Program ${programId} success`
  ]
}

beforeEach(() => {
  installFakeChrome()
  vi.clearAllMocks()
  ownBox = nacl.box.keyPair()
  recipientBox = nacl.box.keyPair()
  ownShielded = `paraloom1${toHex(ownBox.publicKey)}${OWN_SPEND_PUB}`
  recipientShielded = `paraloom1${toHex(recipientBox.publicKey)}${RECIPIENT_SPEND_PUB}`
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Merkle root synchronization across input witnesses (#128)", () => {
  it("aborts before proving when the tree root changes between the two path reads", async () => {
    const n0 = depositNote("600", "sig-0", "01")
    const n1 = depositNote("500", "sig-1", "02")
    await addNote(ownShielded, n0)
    await addNote(ownShielded, n1)

    let pathCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(`${PATH_SERVER_URL}/merkle/path/`)) {
        pathCalls += 1
        return jsonResponse({
          root: pathCalls === 1 ? ROOT_A : ROOT_B,
          path: ["11".repeat(32)],
          indices: [false]
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      transfer(ownShielded, ownShielded, recipientShielded, 900n, [n0, n1], SPEND_PRIVKEY)
    ).rejects.toThrow("Merkle tree updated during witness assembly; retry to synchronize roots")

    expect(pathCalls).toBe(2)
    expect(proveTransferV2).not.toHaveBeenCalled()
    expect(await shieldedBalance(ownShielded)).toBe(1100n)
    expect((await getNotes(ownShielded)).every((n) => !n.spent)).toBe(true)
  })

  it("rejects an empty root from the path server before invoking the prover", async () => {
    const n0 = depositNote("600", "sig-0", "01")
    const n1 = depositNote("500", "sig-1", "02")
    await addNote(ownShielded, n0)
    await addNote(ownShielded, n1)

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          root: "",
          path: ["11".repeat(32)],
          indices: [false]
        })
      )
    )

    await expect(
      transfer(ownShielded, ownShielded, recipientShielded, 900n, [n0, n1], SPEND_PRIVKEY)
    ).rejects.toThrow("Merkle tree updated during witness assembly; retry to synchronize roots")
    expect(proveTransferV2).not.toHaveBeenCalled()
  })
})

describe("deferred local note bookkeeping until settlement (#128)", () => {
  it("leaves inputs unspent and records no phantom change note when queued transfer never settles", async () => {
    const n0 = depositNote("600", "sig-0", "01")
    const n1 = receivedNote("500", "c1".repeat(32), "02")
    await addNote(ownShielded, n0)
    await addDiscoveredNote(ownShielded, n1)

    let inputPathReads = 0
    let outputPollReads = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === `${TRANSFER_INGRESS_URL}/transfer/submit`) {
          return jsonResponse({ request_id: "req-dropped" })
        }
        if (url.startsWith(`${PATH_SERVER_URL}/merkle/path/out0_`)) {
          outputPollReads += 1
          return new Response("not found", { status: 404 })
        }
        if (url.startsWith(`${PATH_SERVER_URL}/merkle/path/`)) {
          inputPathReads += 1
          return jsonResponse({
            root: ROOT_A,
            path: ["11".repeat(32)],
            indices: [inputPathReads === 2]
          })
        }
        throw new Error(`Unexpected fetch: ${url}`)
      })
    )

    const clock = fakeClock()
    const res = await transfer(
      ownShielded,
      ownShielded,
      recipientShielded,
      750n,
      [n0, n1],
      SPEND_PRIVKEY,
      {
        settleTimeoutMs: 18_000,
        settlePollMs: 6_000,
        confirmDeps: clock
      }
    )

    expect(res.requestId).toBe("req-dropped")
    expect(res.settled).toBe(false)
    expect(outputPollReads).toBe(4)

    const stored = await getNotes(ownShielded)
    expect(stored).toHaveLength(2)
    expect(stored.every((n) => !n.spent)).toBe(true)
    expect(await shieldedBalance(ownShielded)).toBe(1100n)
  })

  it("marks only the spent inputs and persists the change note once on-chain tree settlement confirms", async () => {
    const n0 = depositNote("600", "sig-0", "01")
    const n1 = receivedNote("500", "c1".repeat(32), "02")
    const untouchedReceived = receivedNote("300", "c2".repeat(32), "03")
    await addNote(ownShielded, n0)
    await addDiscoveredNote(ownShielded, n1)
    await addDiscoveredNote(ownShielded, untouchedReceived)

    const oc0Hex = "d0".repeat(32)
    const oc1Hex = "d1".repeat(32)
    proveTransferV2.mockResolvedValueOnce({
      nullifiers: ["aa".repeat(32), "bb".repeat(32)],
      output_commitments: [oc0Hex, oc1Hex],
      proof: "cafebabe"
    })

    let submittedBody: {
      new_merkle_root: string
      ciphertexts: string[]
      output_commitments: string[]
    } | null = null

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === `${TRANSFER_INGRESS_URL}/transfer/submit`) {
          submittedBody = JSON.parse(String(init?.body))
          return jsonResponse({ request_id: "req-settled" })
        }
        if (url.startsWith(`${PATH_SERVER_URL}/merkle/path/`)) {
          return jsonResponse({
            root: ROOT_A,
            path: ["22".repeat(32)],
            indices: [false]
          })
        }
        throw new Error(`Unexpected fetch: ${url}`)
      })
    )

    // Poll 1 sees only the pre-existing deposit leaf; poll 2 sees the settled
    // TransactEvent appending oc0Hex and oc1Hex to the on-chain tree.
    let chainPolls = 0
    const connection = {
      async getSignaturesForAddress(_addr: unknown, _opts: { limit: number; before?: string }) {
        chainPolls += 1
        return chainPolls === 1
          ? [{ signature: "sig0", err: null }]
          : [
              { signature: "sig1", err: null },
              { signature: "sig0", err: null }
            ]
      },
      async getTransaction(sig: string) {
        if (sig === "sig0") {
          return { meta: { logMessages: emittedBy(PROGRAM_ID, depositEvent("a0".repeat(32), 0)) } }
        }
        return { meta: { logMessages: emittedBy(PROGRAM_ID, transactEvent(oc0Hex, oc1Hex)) } }
      }
    } as unknown as Connection

    const clock = fakeClock()
    const res = await transfer(
      ownShielded,
      ownShielded,
      recipientShielded,
      750n,
      [n0, n1],
      SPEND_PRIVKEY,
      {
        connection,
        settleTimeoutMs: 30_000,
        settlePollMs: 6_000,
        confirmDeps: clock
      }
    )

    expect(res).toEqual({
      requestId: "req-settled",
      changeCommitment: oc1Hex,
      settled: true
    })
    expect(chainPolls).toBe(2)
    expect(submittedBody?.new_merkle_root).toBe(ROOT_A)

    // Recipient ciphertext decrypts with recipient box secret; change decrypts with ours.
    const recipientNote = tryDecryptNote(recipientBox.secretKey, submittedBody!.ciphertexts[0])
    const ownChangeNote = tryDecryptNote(ownBox.secretKey, submittedBody!.ciphertexts[1])
    expect(recipientNote?.amount).toBe(750n)
    expect(ownChangeNote?.amount).toBe(350n)

    const stored = await getNotes(ownShielded)
    expect(stored.find((n) => n.signature === "sig-0")?.spent).toBe(true)
    expect(stored.find((n) => n.commitment === n1.commitment)?.spent).toBe(true)
    // Unrelated received note (also carrying signature: "") remains unspent (#718).
    expect(stored.find((n) => n.commitment === untouchedReceived.commitment)?.spent).toBe(false)

    const changeStored = stored.find((n) => n.commitment === oc1Hex)
    expect(changeStored).toBeDefined()
    expect(changeStored?.spent).toBe(false)
    expect(changeStored?.amount).toBe("350")
    // 300 untouched + 350 settled change = 650 lamports.
    expect(await shieldedBalance(ownShielded)).toBe(650n)
  })

  it("retries transient path-server 500s during default settlement polling and skips zero-value change notes", async () => {
    const n0 = depositNote("400", "sig-0", "01")
    const n1 = depositNote("600", "sig-1", "02")
    await addNote(ownShielded, n0)
    await addNote(ownShielded, n1)

    let outputPolls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === `${TRANSFER_INGRESS_URL}/transfer/submit`) {
          return jsonResponse({ request_id: "req-exact" })
        }
        if (url.startsWith(`${PATH_SERVER_URL}/merkle/path/out0_`)) {
          outputPolls += 1
          if (outputPolls === 1) return new Response("not indexed", { status: 404 })
          if (outputPolls === 2) return new Response("gateway error", { status: 502 })
          return jsonResponse({ root: ROOT_B, path: ["33".repeat(32)], indices: [true] })
        }
        if (url.startsWith(`${PATH_SERVER_URL}/merkle/path/`)) {
          return jsonResponse({ root: ROOT_A, path: ["11".repeat(32)], indices: [false] })
        }
        throw new Error(`Unexpected fetch: ${url}`)
      })
    )

    const clock = fakeClock()
    const res = await transfer(
      ownShielded,
      ownShielded,
      recipientShielded,
      1000n,
      [n0, n1],
      SPEND_PRIVKEY,
      {
        settleTimeoutMs: 30_000,
        settlePollMs: 6_000,
        confirmDeps: clock
      }
    )

    expect(res.settled).toBe(true)
    expect(outputPolls).toBe(3)
    const stored = await getNotes(ownShielded)
    // Exact-sum spend marks both inputs spent and does NOT store a 0-lamport change note.
    expect(stored).toHaveLength(2)
    expect(stored.every((n) => n.spent)).toBe(true)
    expect(await shieldedBalance(ownShielded)).toBe(0n)
  })

  it("leaves inputs untouched when /transfer/submit rejects with HTTP error", async () => {
    const n0 = depositNote("600", "sig-0", "01")
    const n1 = depositNote("500", "sig-1", "02")
    await addNote(ownShielded, n0)
    await addNote(ownShielded, n1)

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === `${TRANSFER_INGRESS_URL}/transfer/submit`) {
          return new Response("bad proof", { status: 400 })
        }
        return jsonResponse({ root: ROOT_A, path: ["11".repeat(32)], indices: [false] })
      })
    )

    await expect(
      transfer(ownShielded, ownShielded, recipientShielded, 800n, [n0, n1], SPEND_PRIVKEY)
    ).rejects.toThrow("Transfer ingress rejected the transfer (400)")

    expect(await shieldedBalance(ownShielded)).toBe(1100n)
    expect((await getNotes(ownShielded)).every((n) => !n.spent)).toBe(true)
  })
})
