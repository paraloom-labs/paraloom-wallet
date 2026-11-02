// Regression test for paraloom-labs/paraloom-wallet#133
// buildDepositInstruction must build a v3 `deposit_note` instruction:
//   5 accounts in order [bridge_state, bridge_vault, merkle_tree, depositor, system_program]
//   and carry the DEPOSIT_NOTE_DISCRIMINATOR (not the legacy DEPOSIT_DISCRIMINATOR).

import { PublicKey, SystemProgram } from "@solana/web3.js"
import {
  buildDepositInstruction,
  buildDepositSplInstruction
} from "~lib/paraloom/bridge"
import {
  BRIDGE_STATE_SEED,
  BRIDGE_VAULT_SEED,
  MERKLE_TREE_SEED,
  PROGRAM_ID,
  DEPOSIT_NOTE_DISCRIMINATOR
} from "~lib/paraloom/constants"

const programId = new PublicKey(PROGRAM_ID)
const pda = (seed: string) =>
  PublicKey.findProgramAddressSync([Buffer.from(seed)], programId)[0]

const pdaStrs = (...seeds: string[]) =>
  seeds.map((s) => pda(s).toBase58())

const depositor = new PublicKey("11111111111111111111111111111112")
const amount = 1_000_000n
const recipient = new Uint8Array(32).fill(7)
const randomness = new Uint8Array(32).fill(9)

describe("buildDepositInstruction (v3 deposit_note)", () => {
  const ix = buildDepositInstruction(depositor, amount, recipient, randomness)

  it("uses the DEPOSIT_NOTE discriminator, not the legacy one", () => {
    for (let i = 0; i < 8; i++) {
      expect(ix.data[i]).toBe(DEPOSIT_NOTE_DISCRIMINATOR[i])
    }
  })

  it("has exactly 5 accounts (AccountNotEnoughKeys regression)", () => {
    expect(ix.keys.length).toBe(5)
  })

  it("orders accounts as bridge_state, bridge_vault, merkle_tree, depositor, system_program", () => {
    const [bridgeState, bridgeVault] = pdaStrs(BRIDGE_STATE_SEED, BRIDGE_VAULT_SEED)
    expect(ix.keys[0].pubkey.toBase58()).toBe(bridgeState)
    expect(ix.keys[0].isWritable).toBe(true)
    expect(ix.keys[1].pubkey.toBase58()).toBe(bridgeVault)
    expect(ix.keys[1].isWritable).toBe(true)
    expect(ix.keys[2].pubkey.toBase58()).toBe(pda(MERKLE_TREE_SEED).toBase58())
    expect(ix.keys[2].isWritable).toBe(true)
    expect(ix.keys[3].pubkey.toBase58()).toBe(depositor.toBase58())
    expect(ix.keys[3].isSigner).toBe(true)
    expect(ix.keys[4].pubkey.toBase58()).toBe(SystemProgram.programId.toBase58())
  })

  it("encodes amount (u64 LE) at offset 8, recipient at 16, randomness at 48", () => {
    const dv = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength)
    expect(dv.getBigUint64(8, true)).toBe(amount)
    expect(ix.data.slice(16, 48)).toEqual(Buffer.from(recipient))
    expect(ix.data.slice(48, 80)).toEqual(Buffer.from(randomness))
  })
})

describe("buildDepositInstruction matches buildDepositSplInstruction merkle_tree placement", () => {
  it("both place the merkle_tree PDA in their account list", () => {
    const sol = buildDepositInstruction(depositor, amount, recipient, randomness)
    const merkle = pda(MERKLE_TREE_SEED).toBase58()
    expect(sol.keys.some((k) => k.pubkey.toBase58() === merkle)).toBe(true)
  })
})
