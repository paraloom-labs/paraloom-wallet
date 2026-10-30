import { Keypair } from "@solana/web3.js"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { installFakeChrome } from "./support/chromeStorage"
import { getNotes, shieldedBalance } from "~lib/paraloom/notes"
import { sendDepositNote } from "~lib/paraloom/transact"
import { depositV3 } from "~lib/paraloom/transactFlow"
import * as bridge from "~lib/paraloom/bridge"
import * as transact from "~lib/paraloom/transact"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  v3NotePubkey: vi.fn().mockImplementation(async () => "11".repeat(32)),
  v3NoteCommitment: vi.fn().mockImplementation(async () => "22".repeat(32)),
  v3NoteCommitmentAsset: vi.fn().mockImplementation(async () => "33".repeat(32))
}))

const SHIELDED_ADDR = "paraloom1" + "33".repeat(64)
const SPEND_PRIVKEY = "11".repeat(32)

beforeEach(() => {
  installFakeChrome()
})

describe("sendDepositNote confirmation timeout (#181)", () => {
  it("throws when confirmBySignatureStatus returns false (timeout)", async () => {
    vi.spyOn(bridge, "confirmBySignatureStatus").mockResolvedValue(false)

    const payer = Keypair.generate()
    const fakeConn = {
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM" }),
      sendRawTransaction: vi.fn().mockResolvedValue("test-sig-123")
    } as any

    await expect(
      sendDepositNote(
        fakeConn,
        payer,
        1_000_000_000n,
        new Uint8Array(32),
        new Uint8Array(32)
      )
    ).rejects.toThrow("deposit transaction test-sig-123 was not confirmed within timeout")
  })

  it("resolves signature when confirmBySignatureStatus returns true", async () => {
    vi.spyOn(bridge, "confirmBySignatureStatus").mockResolvedValue(true)

    const payer = Keypair.generate()
    const fakeConn = {
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM" }),
      sendRawTransaction: vi.fn().mockResolvedValue("test-sig-ok")
    } as any

    const sig = await sendDepositNote(
      fakeConn,
      payer,
      1_000_000_000n,
      new Uint8Array(32),
      new Uint8Array(32)
    )
    expect(sig).toBe("test-sig-ok")
  })
})

describe("depositV3 phantom note rollback on failure (#181)", () => {
  it("rolls back optimistic note by marking it spent when deposit fails on-chain", async () => {
    vi.spyOn(transact, "sendDepositNote").mockImplementation(async (_conn, _payer, _lamports, _pubkey, _blinding, onSubmitted) => {
      if (onSubmitted) {
        await onSubmitted("reverted-sig-456")
      }
      throw new Error("transaction failed on-chain: {\"InstructionError\":[0,{\"Custom\":1}]}")
    })

    const fakeWallet = {
      secretKey: Keypair.generate().secretKey
    }

    const fakeConn = {} as any

    await expect(
      depositV3(fakeConn, fakeWallet, SHIELDED_ADDR, SPEND_PRIVKEY, 1_000_000_000n)
    ).rejects.toThrow("transaction failed on-chain")

    // The note was persisted during onSubmitted, but rolled back (marked spent) in catch
    const notes = await getNotes(SHIELDED_ADDR)
    expect(notes.length).toBe(1)
    expect(notes[0].spent).toBe(true)
    expect(notes[0].signature).toBe("reverted-sig-456")

    // Unspent balance remains 0, preventing bricked withdrawals
    const unspent = notes.filter((n) => !n.spent)
    expect(unspent.length).toBe(0)
    const balance = await shieldedBalance(SHIELDED_ADDR)
    expect(balance).toBe(0n)
  })

  it("rolls back optimistic note by marking it spent when confirmation times out", async () => {
    vi.spyOn(transact, "sendDepositNote").mockImplementation(async (_conn, _payer, _lamports, _pubkey, _blinding, onSubmitted) => {
      if (onSubmitted) {
        await onSubmitted("timeout-sig-789")
      }
      throw new Error("deposit transaction timeout-sig-789 was not confirmed within timeout")
    })

    const fakeWallet = {
      secretKey: Keypair.generate().secretKey
    }

    const fakeConn = {} as any

    await expect(
      depositV3(fakeConn, fakeWallet, SHIELDED_ADDR, SPEND_PRIVKEY, 2_000_000_000n)
    ).rejects.toThrow("was not confirmed within timeout")

    const notes = await getNotes(SHIELDED_ADDR)
    expect(notes.length).toBe(1)
    expect(notes[0].spent).toBe(true)

    const unspent = notes.filter((n) => !n.spent)
    expect(unspent.length).toBe(0)
    const balance = await shieldedBalance(SHIELDED_ADDR)
    expect(balance).toBe(0n)
  })
})
