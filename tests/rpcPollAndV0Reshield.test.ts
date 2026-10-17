import { describe, expect, it, vi } from "vitest"
import type { Connection } from "@solana/web3.js"
import { PublicKey } from "@solana/web3.js"
import { base58Decode, recoverReshieldedNote } from "~lib/paraloom/bridge"
import {
  DEPOSIT_NOTE_EVENT_DISCRIMINATOR,
  DEPOSIT_NOTE_SPL_DISCRIMINATOR,
  DEPOSIT_NOTE_SPL_EVENT_DISCRIMINATOR,
  PROGRAM_ID,
  TRANSACT_EVENT_DISCRIMINATOR
} from "~lib/paraloom/constants"
import { fetchV3Leaves } from "~lib/paraloom/transact"

// Mock prover
vi.mock("~lib/prover", () => ({ NATIVE_ASSET_HEX: "00".repeat(32) }))

function payload(discriminator: Uint8Array, body: Uint8Array): string {
  const out = new Uint8Array(8 + body.length)
  out.set(discriminator, 0)
  out.set(body, 8)
  return Buffer.from(out).toString("base64")
}

function depositEvent(commitmentByte: number, leafIndex: number): string {
  const body = new Uint8Array(88)
  body.fill(commitmentByte, 40, 72)
  const view = new DataView(body.buffer)
  view.setBigUint64(72, BigInt(leafIndex), true)
  view.setBigInt64(80, 1_700_000_000n, true)
  return payload(DEPOSIT_NOTE_EVENT_DISCRIMINATOR, body)
}

function transactEvent(oc0Byte: number, oc1Byte: number): string {
  const body = new Uint8Array(224)
  body.fill(oc0Byte, 64, 96)
  body.fill(oc1Byte, 96, 128)
  return payload(TRANSACT_EVENT_DISCRIMINATOR, body)
}

function emittedBy(programId: string, ...events: string[]): string[] {
  return [
    `Program ${programId} invoke [1]`,
    ...events.map((e) => `Program data: ${e}`),
    `Program ${programId} success`
  ]
}

describe("Issue #969: base58Decode leading zero & empty string handling", () => {
  it("decodes empty string as 0-length Uint8Array instead of [0]", () => {
    const res = base58Decode("")
    expect(res).toEqual(new Uint8Array(0))
    expect(res.length).toBe(0)
  })

  it("decodes single '1' as 1 zero byte instead of 2 zero bytes", () => {
    const res = base58Decode("1")
    expect(res).toEqual(new Uint8Array([0]))
  })

  it("decodes '11' as exactly 2 zero bytes", () => {
    const res = base58Decode("11")
    expect(res).toEqual(new Uint8Array([0, 0]))
  })

  it("decodes '1'.repeat(5) as exactly 5 zero bytes", () => {
    const res = base58Decode("11111")
    expect(res).toEqual(new Uint8Array([0, 0, 0, 0, 0]))
  })
})

describe("Issue #969: fetchV3Leaves payload length bounds and intra-slot ordering", () => {
  it("silently ignores truncated event payloads without throwing RangeError", async () => {
    // Truncated body (< 80 bytes for deposit, < 128 for transact)
    const truncatedDeposit = payload(DEPOSIT_NOTE_EVENT_DISCRIMINATOR, new Uint8Array(20))
    const truncatedTransact = payload(TRANSACT_EVENT_DISCRIMINATOR, new Uint8Array(50))
    const validDeposit = depositEvent(0xaa, 0)

    const connection = {
      async getSignaturesForAddress() {
        return [{ signature: "sig1", slot: 100, err: null }]
      },
      async getTransaction() {
        return {
          meta: {
            logMessages: emittedBy(PROGRAM_ID, truncatedDeposit, truncatedTransact, validDeposit)
          }
        }
      }
    } as unknown as Connection

    const leaves = await fetchV3Leaves(connection)
    expect(leaves).toHaveLength(1)
    expect(leaves[0].index).toBe(0)
    expect(leaves[0].commitmentHex).toBe("aa".repeat(32))
  })

  it("resolves intra-slot ordering when DepositNoteEvent lands at index 2 and TransactEvent takes 0, 1", async () => {
    // Both transactions share slot 1000.
    // getSignaturesForAddress returns them newest-first: [sigTransact, sigDeposit]
    // Reversing processes [sigDeposit, sigTransact].
    // Deposit has index 2. Transact outputs take unclaimed 0 and 1.
    const sigs = [
      { signature: "sigTransact", slot: 1000, err: null },
      { signature: "sigDeposit", slot: 1000, err: null }
    ]
    const connection = {
      async getSignaturesForAddress() {
        return sigs
      },
      async getTransaction(sig: string) {
        if (sig === "sigDeposit") {
          return { meta: { logMessages: emittedBy(PROGRAM_ID, depositEvent(0xdd, 2)) } }
        }
        return { meta: { logMessages: emittedBy(PROGRAM_ID, transactEvent(0x01, 0x02)) } }
      }
    } as unknown as Connection

    const leaves = await fetchV3Leaves(connection)
    expect(leaves.map((l) => l.index)).toEqual([0, 1, 2])
    expect(leaves[0].commitmentHex).toBe("01".repeat(32))
    expect(leaves[1].commitmentHex).toBe("02".repeat(32))
    expect(leaves[2].commitmentHex).toBe("dd".repeat(32))
  })

  it("resolves intra-slot ordering when DepositNoteEvent lands at index 0 and TransactEvent takes 1, 2", async () => {
    const sigs = [
      { signature: "sigDeposit", slot: 2000, err: null },
      { signature: "sigTransact", slot: 2000, err: null }
    ]
    const connection = {
      async getSignaturesForAddress() {
        return sigs
      },
      async getTransaction(sig: string) {
        if (sig === "sigDeposit") {
          return { meta: { logMessages: emittedBy(PROGRAM_ID, depositEvent(0xaa, 0)) } }
        }
        return { meta: { logMessages: emittedBy(PROGRAM_ID, transactEvent(0xbb, 0xcc)) } }
      }
    } as unknown as Connection

    const leaves = await fetchV3Leaves(connection)
    expect(leaves.map((l) => l.index)).toEqual([0, 1, 2])
    expect(leaves[0].commitmentHex).toBe("aa".repeat(32))
    expect(leaves[1].commitmentHex).toBe("bb".repeat(32))
    expect(leaves[2].commitmentHex).toBe("cc".repeat(32))
  })
})

describe("Issue #969: recoverReshieldedNote with v0 loadedAddresses and innerInstructions", () => {
  function buildSplDepositData(amount: bigint, blinding: Uint8Array): Uint8Array {
    const data = new Uint8Array(80)
    data.set(DEPOSIT_NOTE_SPL_DISCRIMINATOR, 0)
    const dv = new DataView(data.buffer)
    dv.setBigUint64(8, amount, true)
    data.fill(0x11, 16, 48) // pubkey
    data.set(blinding, 48)
    return data
  }

  it("recovers reshielded note when program is in loadedAddresses (v0 lookup table)", async () => {
    const blinding = new Uint8Array(32).fill(0x77)
    const data = buildSplDepositData(5000000n, blinding)

    const programKey = new PublicKey(PROGRAM_ID)
    const freshAddress = PublicKey.default.toBase58()

    const connection = {
      async getSignaturesForAddress() {
        return [{ signature: "sigReshield1" }]
      },
      async getTransaction() {
        return {
          meta: {
            err: null,
            loadedAddresses: {
              writable: [programKey],
              readonly: []
            }
          },
          transaction: {
            message: {
              staticAccountKeys: [new PublicKey(PublicKey.default)], // index 0
              // programIdIndex 1 points to loadedAddresses.writable[0]
              compiledInstructions: [{ programIdIndex: 1, data }]
            }
          }
        }
      }
    } as unknown as Connection

    const note = await recoverReshieldedNote(connection, freshAddress)
    expect(note).not.toBeNull()
    expect(note?.amount).toBe("5000000")
    expect(note?.blindingHex).toBe("77".repeat(32))
    expect(note?.signature).toBe("sigReshield1")
  })

  it("recovers reshielded note from innerInstructions (CPI invocation)", async () => {
    const blinding = new Uint8Array(32).fill(0x88)
    const data = buildSplDepositData(1234567n, blinding)

    const programKey = new PublicKey(PROGRAM_ID)
    const freshAddress = PublicKey.default.toBase58()

    const connection = {
      async getSignaturesForAddress() {
        return [{ signature: "sigReshield2" }]
      },
      async getTransaction() {
        return {
          meta: {
            err: null,
            innerInstructions: [
              {
                index: 0,
                instructions: [
                  {
                    programIdIndex: 0,
                    data
                  }
                ]
              }
            ]
          },
          transaction: {
            message: {
              staticAccountKeys: [programKey],
              compiledInstructions: [] // no top-level instructions for program
            }
          }
        }
      }
    } as unknown as Connection

    const note = await recoverReshieldedNote(connection, freshAddress)
    expect(note).not.toBeNull()
    expect(note?.amount).toBe("1234567")
    expect(note?.blindingHex).toBe("88".repeat(32))
    expect(note?.signature).toBe("sigReshield2")
  })
})

describe("Issue #969: waitForFunding & waitForSwapConfirmation transient RPC tolerance", () => {
  it("waitForFunding survives transient getBalance RPC error and returns balance", async () => {
    const { waitForFunding } = await import("~lib/paraloom/privateSwap")
    let calls = 0
    const connection = {
      async getBalance() {
        calls++
        if (calls === 1) {
          throw new Error("503 Service Unavailable / Network error")
        }
        return 1_500_000
      }
    } as unknown as Connection

    const bal = await waitForFunding(connection, PublicKey.default)
    expect(bal).toBe(1_500_000n)
    expect(calls).toBe(2)
  }, 15_000)

  it("waitForSwapConfirmation survives transient getSignatureStatus RPC error and confirms", async () => {
    const { waitForSwapConfirmation } = await import("~lib/paraloom/privateSwap")
    let calls = 0
    const connection = {
      async getSignatureStatus() {
        calls++
        if (calls === 1) {
          throw new Error("429 Too Many Requests")
        }
        return { value: { confirmationStatus: "confirmed", err: null } }
      }
    } as unknown as Connection

    await expect(waitForSwapConfirmation(connection, "mockSig", 10_000)).resolves.toBeUndefined()
    expect(calls).toBe(2)
  })

  it("waitForSwapConfirmation immediately rejects on genuine on-chain err", async () => {
    const { waitForSwapConfirmation } = await import("~lib/paraloom/privateSwap")
    const connection = {
      async getSignatureStatus() {
        return { value: { confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } } }
      }
    } as unknown as Connection

    await expect(waitForSwapConfirmation(connection, "mockSig", 10_000)).rejects.toThrow(
      "swap transaction failed on-chain"
    )
  })
})
