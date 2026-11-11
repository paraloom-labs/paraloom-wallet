import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { Keypair, SystemProgram } from '@solana/web3.js'
import { buildDepositInstruction } from '../lib/paraloom/bridge'

function anchorDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)
}

describe('buildDepositInstruction (native SOL deposit)', () => {
  const depositor = Keypair.generate().publicKey
  const recipient = new Uint8Array(32).fill(7)
  const randomness = new Uint8Array(32).fill(9)

  it('includes the merkle_tree PDA so the DepositNote account layout has 5 accounts', () => {
    const ix = buildDepositInstruction(depositor, 1_000_000n, recipient, randomness)

    // Expected order: bridge_state, bridge_vault, merkle_tree, depositor, system_program
    expect(ix.keys.length).toBe(5)

    const [bridgeState, bridgeVault, merkleTree, signer, systemProgram] = ix.keys

    expect(bridgeState.isWritable).toBe(true)
    expect(bridgeState.isSigner).toBe(false)
    expect(bridgeVault.isWritable).toBe(true)
    expect(bridgeVault.isSigner).toBe(false)

    // merkle_tree PDA: writable, non-signer, distinct from other accounts
    expect(merkleTree.isWritable).toBe(true)
    expect(merkleTree.isSigner).toBe(false)
    expect(merkleTree.pubkey.equals(depositor)).toBe(false)
    expect(merkleTree.pubkey.equals(bridgeState.pubkey)).toBe(false)
    expect(merkleTree.pubkey.equals(bridgeVault.pubkey)).toBe(false)
    expect(merkleTree.pubkey.equals(SystemProgram.programId)).toBe(false)

    expect(signer.pubkey.equals(depositor)).toBe(true)
    expect(signer.isSigner).toBe(true)
    expect(signer.isWritable).toBe(true)

    expect(systemProgram.pubkey.equals(SystemProgram.programId)).toBe(true)
    expect(systemProgram.isSigner).toBe(false)
  })

  it('uses the deposit_note Anchor discriminator rather than the obsolete deposit one', () => {
    const ix = buildDepositInstruction(depositor, 1_000_000n, recipient, randomness)
    const disc = Buffer.from(ix.data.subarray(0, 8))

    expect(disc.equals(anchorDiscriminator('deposit_note'))).toBe(true)
    expect(disc.equals(anchorDiscriminator('deposit'))).toBe(false)
  })
})