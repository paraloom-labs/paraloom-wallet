import { beforeEach, describe, expect, it, vi } from "vitest"
import { Keypair } from "@solana/web3.js"
import { installFakeChrome } from "./support/chromeStorage"

vi.mock("~lib/prover", () => ({
  assetIdForMint: vi.fn(async (m: string) => m.slice(0, 64).padEnd(64, "a")),
  NATIVE_ASSET_HEX: "00".repeat(32)
}))

import {
  classifyStrand,
  isNativeSolOutput,
  RESUME_GRACE_MS,
  RESUME_MIN_LAMPORTS,
  WSOL_MINT
} from "../lib/paraloom/swapReconcileClassify"

const OLD = RESUME_GRACE_MS + 1

describe("classifyStrand", () => {
  it("skips a row that already has a signature (done)", () => {
    expect(
      classifyStrand({
        hasSignature: true,
        ageMs: OLD,
        solLamports: 10_000_000n,
        tokenAmount: 0n
      })
    ).toBe("skip")
  })

  it("skips a row still inside the in-flight grace window", () => {
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: RESUME_GRACE_MS - 1,
        solLamports: 10_000_000n,
        tokenAmount: 5_000_000n
      })
    ).toBe("skip")
  })

  it("resumes when the fresh address still holds swappable SOL", () => {
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: OLD,
        solLamports: RESUME_MIN_LAMPORTS + 1n,
        tokenAmount: 0n
      })
    ).toBe("resume")
  })

  it("marks landed when SOL is gone but the bought token sits at the address", () => {
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: OLD,
        solLamports: RESUME_MIN_LAMPORTS,
        tokenAmount: 597_800n
      })
    ).toBe("landed")
  })

  it("leaves a strand unresolved when nothing is recoverable on-chain", () => {
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: OLD,
        solLamports: 0n,
        tokenAmount: 0n
      })
    ).toBe("unresolved")
  })

  it("prefers resume over landed when both SOL and token are present", () => {
    // A partially-funded address that also holds dust token: finishing the swap
    // of the remaining SOL is the correct move, not treating it as already done.
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: OLD,
        solLamports: RESUME_MIN_LAMPORTS + 1n,
        tokenAmount: 100n
      })
    ).toBe("resume")
  })

  it("does not resume on exactly the reserve threshold (nothing left to swap)", () => {
    expect(
      classifyStrand({
        hasSignature: false,
        ageMs: OLD,
        solLamports: RESUME_MIN_LAMPORTS,
        tokenAmount: 0n
      })
    ).toBe("unresolved")
  })
})

describe("isNativeSolOutput", () => {
  it("treats the wrapped-SOL mint as native SOL (the app sends this, not 'SOL')", () => {
    expect(isNativeSolOutput(WSOL_MINT)).toBe(true)
  })

  it("treats the literal 'SOL' as native SOL", () => {
    expect(isNativeSolOutput("SOL")).toBe(true)
  })

  it("treats USDC (any SPL mint) as NOT native SOL", () => {
    expect(isNativeSolOutput("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(false)
  })
})

describe("routeSwap validation and slippage forwarding", () => {
  it("forwards slippage_bps and validates router response payload", async () => {
    const { routeSwap } = await import("../lib/paraloom/privateSwap")
    const calls: { url: string; body: Record<string, unknown> }[] = []
    const origFetch = globalThis.fetch
    try {
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) })
        return new Response(
          JSON.stringify({ out_amount: 123_456, swap_transaction: "AQ==" }),
          { status: 200 }
        )
      }) as typeof fetch

      const quote = await routeSwap("FreshPub111", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 5_000_000n, "SOL", 250)
      expect(quote).toEqual({ out_amount: 123_456, swap_transaction: "AQ==" })
      expect(calls).toHaveLength(1)
      expect(calls[0].body.slippage_bps).toBe(250)
      expect(calls[0].body.amount).toBe(5_000_000)

      await expect(
        routeSwap("FreshPub111", "SOL", 0n, "SOL", 100)
      ).rejects.toThrow(/safe integer/)
      await expect(
        routeSwap("FreshPub111", "SOL", 1_000n, "SOL", 0)
      ).rejects.toThrow(/slippageBps/)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe("reconcileSwapOutputs & reshieldRecovery hardening", () => {
  beforeEach(() => {
    installFakeChrome()
  })

  it("validates persistReshieldedNote fields and skips WSOL_MINT in recoverReshields", async () => {
    const { persistReshieldedNote, recoverReshields } = await import(
      "../lib/paraloom/reshieldRecovery"
    )
    const { saveSwapOutput } = await import("../lib/paraloom/swapOutputs")
    const account = "paraloom1" + "11".repeat(64)

    await expect(
      persistReshieldedNote(account, {
        assetId: "ab".repeat(32),
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: "0",
        blindingHex: "cd".repeat(32),
        depositSignature: "sig-1"
      })
    ).rejects.toThrow(/amount must be > 0/)

    await expect(
      persistReshieldedNote(account, {
        assetId: "not-hex",
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: "1000",
        blindingHex: "cd".repeat(32),
        depositSignature: "sig-1"
      })
    ).rejects.toThrow(/blindingHex or assetId/)

    const kp = Keypair.generate()
    await saveSwapOutput({
      freshAddress: kp.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(kp.secretKey).toString("hex"),
      outputMint: WSOL_MINT,
      outAmount: 10_000_000,
      swapSignature: "sig-wsol",
      reshield: true,
      createdAt: 1000
    })

    const fakeConn = {
      getSignaturesForAddress: vi.fn()
    } as never
    expect(await recoverReshields(fakeConn, account)).toBe(0)
    expect(
      (fakeConn as { getSignaturesForAddress: ReturnType<typeof vi.fn> }).getSignaturesForAddress
    ).not.toHaveBeenCalled()
  })

  it("reconcileSwapOutputs skips malformed freshAddress rows and ignores failed on-chain signatures", async () => {
    const { reconcileSwapOutputs } = await import("../lib/paraloom/swapReconcile")
    const { listSwapOutputs, saveSwapOutput } = await import("../lib/paraloom/swapOutputs")
    const kp = Keypair.generate()

    await saveSwapOutput({
      freshAddress: "not-a-valid-pubkey",
      freshSecretKeyHex: "00".repeat(64),
      outputMint: "SOL",
      outAmount: 0,
      swapSignature: "",
      createdAt: 1
    })
    await saveSwapOutput({
      freshAddress: kp.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(kp.secretKey).toString("hex"),
      outputMint: WSOL_MINT,
      outAmount: 0,
      swapSignature: "",
      createdAt: 1
    })

    const fakeConn = {
      getBalance: vi.fn(async () => Number(RESUME_MIN_LAMPORTS + 5_000_000n)),
      getSignaturesForAddress: vi.fn(async () => [
        { signature: "sig-failed", err: { InstructionError: [0, "Custom"] } },
        { signature: "sig-confirmed-ok", err: null }
      ])
    } as never

    const resolved = await reconcileSwapOutputs(fakeConn, "paraloom1" + "22".repeat(64))
    expect(resolved).toBe(1)
    const rows = await listSwapOutputs()
    const updated = rows.find((r) => r.freshAddress === kp.publicKey.toBase58())
    expect(updated?.swapSignature).toBe("sig-confirmed-ok")
  })
})
