import { Keypair, PublicKey } from "@solana/web3.js"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { depositSpl } from "~lib/paraloom/bridge"
import { recoverReshields } from "~lib/paraloom/reshieldRecovery"
import {
  listSwapOutputs,
  saveSwapOutput,
  type SwapOutput
} from "~lib/paraloom/swapOutputs"
import { installFakeChrome } from "./support/chromeStorage"

// The bridge module is partially stubbed ONLY for the recovery-pass tests:
// the real depositSpl is exercised directly against a fake connection below,
// while recoverReshields is tested against both deposit outcomes.
const bridgeStub = vi.hoisted(() => ({
  depositSpl: vi.fn(),
  recoverReshieldedNote: vi.fn(async () => null),
  realDepositSpl: null as unknown
}))

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  assetIdForMint: vi.fn(async () => "ab".repeat(32))
}))

vi.mock("~lib/paraloom/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~lib/paraloom/bridge")>()
  bridgeStub.realDepositSpl = actual.depositSpl
  return {
    ...actual,
    depositSpl: bridgeStub.depositSpl,
    recoverReshieldedNote: bridgeStub.recoverReshieldedNote
  }
})

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
const ACCOUNT = "paraloom1" + "11".repeat(64)
const ASSET_ID = "ab".repeat(32)

function fakeConnection(statusValue: unknown) {
  return {
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
      lastValidBlockHeight: 1000
    })),
    sendRawTransaction: vi.fn(async () => "dep-signature"),
    getSignatureStatus: vi.fn(async () => ({ value: statusValue })),
    getTokenAccountBalance: vi.fn(async () => ({
      value: { amount: "5000", decimals: 6, uiAmount: 0.005 }
    }))
  }
}

describe("depositSpl confirmation outcome (#117)", () => {
  beforeEach(() => {
    // These two tests exercise the REAL depositSpl against a fake connection.
    bridgeStub.depositSpl.mockReset()
    bridgeStub.depositSpl.mockImplementation(
      bridgeStub.realDepositSpl as (...args: never[]) => Promise<unknown>
    )
  })

  it("reports confirmed=true when the deposit confirms inside the window", async () => {
    const conn = fakeConnection({
      confirmationStatus: "confirmed",
      err: null
    })
    const onSubmitted = vi.fn(async (_r: { signature: string }) => {})

    const res = await depositSpl(
      conn as never,
      Keypair.generate(),
      ACCOUNT,
      USDC,
      5000n,
      ASSET_ID,
      undefined,
      onSubmitted,
      1_000
    )

    expect(res.confirmed).toBe(true)
    expect(res.signature).toBe("dep-signature")
    // The note handle is still delivered at submit time (#reshield-note-loss).
    expect(onSubmitted).toHaveBeenCalledTimes(1)
    expect(onSubmitted.mock.calls[0]?.[0]?.signature).toBe("dep-signature")
  })

  it("reports confirmed=false on a timeout instead of silently succeeding, and keeps the recovery handle", async () => {
    vi.useFakeTimers()
    try {
      const conn = fakeConnection(null)
      const p = depositSpl(
        conn as never,
        Keypair.generate(),
        ACCOUNT,
        USDC,
        5000n,
        ASSET_ID,
        undefined,
        undefined,
        250
      )
      await vi.advanceTimersByTimeAsync(5_000)
      const res = await p

      expect(res.confirmed).toBe(false)
      // A dropped-or-late deposit is NOT a thrown-away deposit: signature and
      // blinding survive so recovery can settle the strand later. (Throwing
      // here — the naive fix — would discard both.)
      expect(res.signature).toBe("dep-signature")
      expect(res.blinding).toHaveLength(32)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("recoverReshields on an unconfirmed Case B deposit (#117)", () => {
  const fresh = Keypair.generate()

  function strand(): SwapOutput {
    return {
      freshAddress: fresh.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(fresh.secretKey).toString("hex"),
      outputMint: USDC.toBase58(),
      outAmount: 5000,
      swapSignature: "swap-signature",
      reshield: true,
      createdAt: 1
    }
  }

  beforeEach(() => {
    installFakeChrome()
    bridgeStub.depositSpl.mockReset()
    bridgeStub.recoverReshieldedNote.mockReset()
    bridgeStub.recoverReshieldedNote.mockResolvedValue(null)
  })

  it("does NOT mark the strand recovered when the deposit is unconfirmed, so a later pass can settle it", async () => {
    bridgeStub.depositSpl.mockImplementation(async (...args: unknown[]) => {
      const onSubmitted = args[7] as
        | ((r: unknown) => Promise<void>)
        | undefined
      const result = {
        signature: "dep-signature",
        blinding: new Uint8Array(32),
        assetId: ASSET_ID,
        amount: 5000n,
        confirmed: false
      }
      if (onSubmitted) await onSubmitted(result)
      return result
    })
    await saveSwapOutput(strand())

    const recovered = await recoverReshields(fakeConnection(null) as never, ACCOUNT)

    expect(recovered).toBe(0)
    const rows = await listSwapOutputs()
    expect(rows).toHaveLength(1)
    expect(rows[0].reshieldRecovered).toBeFalsy()
  })

  it("marks the strand recovered once the deposit actually confirms", async () => {
    bridgeStub.depositSpl.mockImplementation(async (...args: unknown[]) => {
      const onSubmitted = args[7] as
        | ((r: unknown) => Promise<void>)
        | undefined
      const result = {
        signature: "dep-signature",
        blinding: new Uint8Array(32),
        assetId: ASSET_ID,
        amount: 5000n,
        confirmed: true
      }
      if (onSubmitted) await onSubmitted(result)
      return result
    })
    await saveSwapOutput(strand())

    const recovered = await recoverReshields(fakeConnection(null) as never, ACCOUNT)

    expect(recovered).toBe(1)
    const rows = await listSwapOutputs()
    expect(rows[0].reshieldRecovered).toBe(true)
  })
})
