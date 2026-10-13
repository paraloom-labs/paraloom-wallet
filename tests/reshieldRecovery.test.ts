import { Connection, Keypair, PublicKey } from "@solana/web3.js"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEPOSIT_NOTE_DISCRIMINATOR, PROGRAM_ID } from "~lib/paraloom/constants"
import { getNotes } from "~lib/paraloom/notes"
import { recoverReshields } from "~lib/paraloom/reshieldRecovery"
import { listSwapOutputs, saveSwapOutput } from "~lib/paraloom/swapOutputs"
import { WSOL_MINT } from "~lib/paraloom/swapReconcileClassify"
import { installFakeChrome } from "./support/chromeStorage"

const sendDepositNoteMock = vi.fn()

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  assetIdForMint: vi.fn(async (mintHex: string) => mintHex),
  v3NoteCommitment: vi.fn(
    async (amount: bigint, pubkeyHex: string, blindingHex: string) =>
      `${amount.toString(16).padStart(16, "0")}${pubkeyHex.slice(0, 24)}${blindingHex.slice(0, 24)}`
  )
}))

vi.mock("~lib/paraloom/transact", () => ({
  sendDepositNote: (...args: unknown[]) => sendDepositNoteMock(...args)
}))

const SHIELDED_ADDRESS = "paraloom1" + "11".repeat(64)

beforeEach(() => {
  installFakeChrome()
  sendDepositNoteMock.mockReset()
})

describe("recoverReshields native SOL / WSOL_MINT round-trip recovery", () => {
  it("Case A: recovers an already-landed native deposit_note for a WSOL_MINT round-trip output", async () => {
    const fresh = Keypair.generate()
    await saveSwapOutput({
      freshAddress: fresh.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(fresh.secretKey).toString("hex"),
      outputMint: WSOL_MINT,
      outAmount: 50_000_000,
      swapSignature: "swap-sig-1",
      reshield: true,
      createdAt: 1000
    })

    // Build 80-byte deposit_note instruction data: disc(8) | amount u64 LE(8) | pubkey(32) | blinding(32)
    const ixData = new Uint8Array(80)
    ixData.set(DEPOSIT_NOTE_DISCRIMINATOR, 0)
    new DataView(ixData.buffer).setBigUint64(8, 49_000_000n, true)
    ixData.fill(0x11, 16, 48)
    ixData.fill(0x2a, 48, 80)

    const fakeConnection = {
      getSignaturesForAddress: vi.fn().mockResolvedValue([
        { signature: "dep-native-sig-1", err: null }
      ]),
      getTransaction: vi.fn().mockResolvedValue({
        meta: { err: null },
        transaction: {
          message: {
            staticAccountKeys: [new PublicKey(PROGRAM_ID)],
            compiledInstructions: [
              {
                programIdIndex: 0,
                data: ixData
              }
            ]
          }
        }
      })
    } as unknown as Connection

    const recovered = await recoverReshields(fakeConnection, SHIELDED_ADDRESS)
    expect(recovered).toBe(1)

    const notes = await getNotes(SHIELDED_ADDRESS)
    expect(notes).toHaveLength(1)
    expect(notes[0].amount).toBe("49000000")
    expect(notes[0].blinding).toBe("2a".repeat(32))
    expect(notes[0].assetId).toBe("00".repeat(32))
    expect(notes[0].signature).toBe("dep-native-sig-1")

    const outputs = await listSwapOutputs()
    expect(outputs[0].reshieldRecovered).toBe(true)
  })

  it("Case B: sweeps stranded native SOL at freshAddress via sendDepositNote when no deposit_note landed", async () => {
    const fresh = Keypair.generate()
    await saveSwapOutput({
      freshAddress: fresh.publicKey.toBase58(),
      freshSecretKeyHex: Buffer.from(fresh.secretKey).toString("hex"),
      outputMint: WSOL_MINT,
      outAmount: 25_000_000,
      swapSignature: "swap-sig-2",
      reshield: true,
      createdAt: 2000
    })

    sendDepositNoteMock.mockImplementation(
      async (
        _conn: unknown,
        _payer: unknown,
        _amount: bigint,
        _pubkey: Uint8Array,
        _blinding: Uint8Array,
        onSubmitted?: (sig: string) => Promise<void>
      ) => {
        if (onSubmitted) await onSubmitted("swept-native-sig-2")
        return "swept-native-sig-2"
      }
    )

    const fakeConnection = {
      getSignaturesForAddress: vi.fn().mockResolvedValue([]),
      getBalance: vi.fn().mockResolvedValue(25_000_000)
    } as unknown as Connection

    const recovered = await recoverReshields(fakeConnection, SHIELDED_ADDRESS)
    expect(recovered).toBe(1)
    expect(sendDepositNoteMock).toHaveBeenCalledTimes(1)

    const notes = await getNotes(SHIELDED_ADDRESS)
    expect(notes).toHaveLength(1)
    expect(notes[0].amount).toBe("24000000") // 25_000_000 - 1_000_000 reserve
    expect(notes[0].assetId).toBe("00".repeat(32))
    expect(notes[0].signature).toBe("swept-native-sig-2")

    const outputs = await listSwapOutputs()
    expect(outputs[0].reshieldRecovered).toBe(true)
  })
})
