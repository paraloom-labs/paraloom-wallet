import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js"
import { depositSpl } from "~lib/paraloom/bridge"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("~lib/crypto/keyManagement", () => ({
  addressSpendPubHex: () => "01".repeat(32)
}))
vi.mock("~lib/prover", () => ({ NATIVE_ASSET_HEX: "00".repeat(32) }))

const shieldedAddress = `paraloom1${"01".repeat(64)}`

describe("depositSpl confirmation timeout", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("keeps the submitted note pending and rejects when the signature never confirms", async () => {
    vi.useFakeTimers()
    const submitted: string[] = []
    const confirmed: string[] = []
    const connection = {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: SystemProgram.programId.toBase58() })),
      sendRawTransaction: vi.fn(async () => "dropped-signature"),
      getSignatureStatus: vi.fn(async () => ({ value: null }))
    } as unknown as Connection

    const pending = depositSpl(
      connection,
      Keypair.generate(),
      shieldedAddress,
      new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
      1_000_000n,
      "11".repeat(32),
      undefined,
      async (result) => {
        submitted.push(result.signature)
      },
      async (result) => {
        confirmed.push(result.signature)
      }
    )
    const rejection = expect(pending).rejects.toThrow(
      "transaction confirmation timed out: dropped-signature"
    )

    await vi.advanceTimersByTimeAsync(92_000)

    await rejection
    expect(submitted).toEqual(["dropped-signature"])
    expect(confirmed).toEqual([])
    expect(connection.getSignatureStatus).toHaveBeenCalled()
  })
})
