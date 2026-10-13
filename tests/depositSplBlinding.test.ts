import { Connection, Keypair, PublicKey } from "@solana/web3.js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { depositSpl } from "~lib/paraloom/bridge"

vi.mock("~lib/prover", () => ({ NATIVE_ASSET_HEX: "00".repeat(32) }))

// BN254 scalar field modulus r (big-endian):
// 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
const BN254_MODULUS =
  0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n

function leBytesToBigInt(bytes: Uint8Array): bigint {
  let acc = 0n
  for (let i = bytes.length - 1; i >= 0; i--) {
    acc = (acc << 8n) | BigInt(bytes[i])
  }
  return acc
}

describe("depositSpl canonical BN254 blinding clamp", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("clamps blinding[31] <= 0x1f (< BN254 modulus) even when getRandomValues returns all 0xff", async () => {
    const origGetRandomValues = crypto.getRandomValues.bind(crypto)
    let mockedFirst32 = false
    vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
      if (!mockedFirst32 && arr instanceof Uint8Array && arr.length === 32) {
        mockedFirst32 = true
        arr.fill(0xff)
        return arr
      }
      return origGetRandomValues(arr as Uint8Array) as unknown as T
    })

    const fakeConnection = {
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 100
      }),
      sendRawTransaction: vi.fn().mockResolvedValue("5".repeat(88)),
      getSignatureStatus: vi.fn().mockResolvedValue({
        value: { confirmationStatus: "confirmed", err: null }
      })
    } as unknown as Connection

    const depositor = Keypair.generate()
    const mint = Keypair.generate().publicKey
    const shieldedAddress = "paraloom1" + "11".repeat(64)

    let submittedBlinding: Uint8Array | null = null
    const res = await depositSpl(
      fakeConnection,
      depositor,
      shieldedAddress,
      mint,
      1_000_000n,
      "00".repeat(32),
      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      async (submitted) => {
        submittedBlinding = submitted.blinding
      }
    )

    expect(res.blinding).toHaveLength(32)
    expect(res.blinding[31]).toBe(0x1f)
    expect(submittedBlinding?.[31]).toBe(0x1f)
    expect(leBytesToBigInt(res.blinding)).toBeLessThan(BN254_MODULUS)
  })
})
