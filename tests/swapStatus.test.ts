import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../lib/paraloom/privateSwap", () => ({
  isNativeSolOutput: vi.fn((mint: string) => mint === "SOL"),
  resumeSwapAtFreshAddress: vi.fn(async () => {
    throw new Error("not used in this test")
  })
}))
vi.mock("../lib/paraloom/reshieldRecovery", () => ({
  persistReshieldedNote: vi.fn()
}))

import { installFakeChrome } from "./support/chromeStorage"
import { saveSwapOutput, listSwapOutputs } from "../lib/paraloom/swapOutputs"
import { reconcileSwapOutputs } from "../lib/paraloom/swapReconcile"
import { PublicKey } from "@solana/web3.js"

const OLD = 130_000 // > RESUME_GRACE_MS (120_000)

const ADDR1 = PublicKey.default.toBase58()
const ADDR2 = new PublicKey(new Uint8Array(32).fill(1)).toBase58()
const ADDR3 = new PublicKey(new Uint8Array(32).fill(2)).toBase58()
const ADDR4 = new PublicKey(new Uint8Array(32).fill(3)).toBase58()

function makeConnection(opts: {
  sigStatus?: "confirmed" | "finalized" | "processed"
  balance?: bigint
  tokenAmount?: bigint
} = {}) {
  return {
    getSignatureStatus: vi.fn(async () => ({
      value: {
        confirmationStatus: opts.sigStatus ?? "processed",
        err: null,
        blockHeight: 100
      }
    })),
    getBalance: vi.fn(async () => opts.balance ?? 0n),
    getParsedTokenAccountsByOwner: vi.fn(async () => ({
      value: opts.tokenAmount
        ? [{
            account: {
              data: { parsed: { info: { tokenAmount: { amount: String(opts.tokenAmount!) } } } }
            }
          }]
        : []
    })),
    getSignaturesForAddress: vi.fn(async () => [] as string[])
  } as any
}

describe("reconcileSwapOutputs — submitted vs confirmed signatures (#856)", () => {
  let chrome: ReturnType<typeof installFakeChrome>

  beforeEach(async () => {
    chrome = installFakeChrome()
    vi.resetModules()
  })

  it("skips rows marked confirmed without an RPC call", async () => {
    await saveSwapOutput({
      freshAddress: ADDR1,
      freshSecretKeyHex: "aa",
      outputMint: "USDC_MINT",
      outAmount: 1_000_000,
      swapSignature: "subm_confirmed_sig",
      swapStatus: "confirmed",
      createdAt: Date.now() - OLD
    })
    const conn = makeConnection()
    const resolved = await reconcileSwapOutputs(conn, "ShieldedAddr")
    expect(resolved).toBe(0)
    expect(conn.getSignatureStatus).not.toHaveBeenCalled()
    expect(conn.getBalance).not.toHaveBeenCalled()
  })

  it("verifies a submitted signature that actually confirmed on-chain", async () => {
    await saveSwapOutput({
      freshAddress: ADDR2,
      freshSecretKeyHex: "bb",
      outputMint: "USDC_MINT",
      outAmount: 2_000_000,
      swapSignature: "subm_submitted_sig",
      swapStatus: "submitted",
      createdAt: Date.now() - OLD
    })
    const conn = makeConnection({ sigStatus: "confirmed" })
    const resolved = await reconcileSwapOutputs(conn, "ShieldedAddr")
    expect(resolved).toBe(1)
    expect(conn.getSignatureStatus).toHaveBeenCalledWith("subm_submitted_sig")
    const rows = await listSwapOutputs()
    const row = rows.find((r) => r.freshAddress === ADDR2)!
    expect(row.swapStatus).toBe("confirmed")
  })

  it("routes a submitted signature with unconfirmed status to balance checks", async () => {
    await saveSwapOutput({
      freshAddress: ADDR3,
      freshSecretKeyHex: "cc",
      outputMint: "USDC_MINT",
      outAmount: 3_000_000,
      swapSignature: "subm_unconfirmed_sig",
      swapStatus: "submitted",
      createdAt: Date.now() - OLD
    })
    const conn = makeConnection({ sigStatus: "processed", balance: 10_000_000n })
    const resolved = await reconcileSwapOutputs(conn, "ShieldedAddr")
    expect(conn.getSignatureStatus).toHaveBeenCalledWith("subm_unconfirmed_sig")
    expect(conn.getBalance).toHaveBeenCalled()
  })

  it("handles legacy rows (swapSignature set, no swapStatus) by verifying via RPC", async () => {
    await saveSwapOutput({
      freshAddress: ADDR4,
      freshSecretKeyHex: "dd",
      outputMint: "USDC_MINT",
      outAmount: 4_000_000,
      swapSignature: "legacy_sig",
      createdAt: Date.now() - OLD
    })
    const conn = makeConnection({ sigStatus: "finalized" })
    const resolved = await reconcileSwapOutputs(conn, "ShieldedAddr")
    expect(resolved).toBe(1)
    const rows = await listSwapOutputs()
    const row = rows.find((r) => r.freshAddress === ADDR4)!
    expect(row.swapStatus).toBe("confirmed")
  })
})
