import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction
} from "@solana/web3.js"

import { addressSpendPubHex, type WalletKeyPair } from "~lib/crypto/keyManagement"
import { NATIVE_ASSET_HEX } from "~lib/prover"

import {
  ASSET_CONFIG_SEED,
  ASSET_VAULT_SEED,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  BRIDGE_STATE_SEED,
  BRIDGE_VAULT_SEED,
  DEPOSIT_DISCRIMINATOR,
  DEPOSIT_NOTE_SPL_DISCRIMINATOR,
  MERKLE_TREE_SEED,
  PROGRAM_ID,
  RPC_URLS,
  TOKEN_PROGRAM_ID
} from "./constants"

export type Network = "mainnet-beta" | "devnet"

// A `fetch` that retries the RPC on a transient upstream failure (5xx or a
// network error) with backoff, so a single Helius/proxy blip mid-swap cannot
// abort the whole flow ("failed to get balance ... 500 Internal server error").
// JSON-RPC reads are idempotent, and sendTransaction is deduped by signature, so
// re-issuing the same request is safe. 4xx is returned as-is (a real client
// error, not worth retrying).
async function retryingFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(input, init)
      if (res.status < 500) return res
      lastErr = new Error(`RPC ${res.status}`)
    } catch (e) {
      lastErr = e
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 300 * 2 ** attempt))
  }
  // Exhausted retries: one last attempt, letting a genuine failure surface.
  try {
    return await fetch(input, init)
  } catch {
    throw lastErr instanceof Error ? lastErr : new Error("RPC request failed")
  }
}

export function getConnection(network: Network): Connection {
  return new Connection(RPC_URLS[network], {
    commitment: "confirmed",
    fetch: retryingFetch
  })
}

const programId = new PublicKey(PROGRAM_ID)

function bridgeStatePda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(BRIDGE_STATE_SEED)], programId)[0]
}

function bridgeVaultPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(BRIDGE_VAULT_SEED)], programId)[0]
}

function merkleTreePda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(MERKLE_TREE_SEED)], programId)[0]
}

// The 32-byte shielded-pool recipient carried by a `paraloom1<hex>` address.
export function shieldedAddressToBytes(shieldedAddress: string): Uint8Array {
  const hex = shieldedAddress.replace(/^paraloom1/, "")
  if (hex.length !== 64) {
    throw new Error("invalid shielded address")
  }
  return Uint8Array.from(Buffer.from(hex, "hex"))
}

// Layout: DEPOSIT_NOTE_SPL discriminator (8) | amount u64 LE (8) | recipient (32) | randomness (32).
function depositInstructionData(
  amountLamports: bigint,
  recipient: Uint8Array,
  randomness: Uint8Array
): Buffer {
  const data = new Uint8Array(8 + 8 + 32 + 32)
  data.set(DEPOSIT_NOTE_SPL_DISCRIMINATOR, 0)
  new DataView(data.buffer).setBigUint64(8, amountLamports, true)
  data.set(recipient, 16)
  data.set(randomness, 48)
  return Buffer.from(data)
}

export function buildDepositInstruction(
  depositor: PublicKey,
  amountLamports: bigint,
  recipient: Uint8Array,
  randomness: Uint8Array
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: bridgeStatePda(), isSigner: false, isWritable: false },
      { pubkey: bridgeVaultPda(), isSigner: false, isWritable: true },
      { pubkey: merkleTreePda(), isSigner: false, isWritable: true },
      { pubkey: depositor, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: depositInstructionData(amountLamports, recipient, randomness)
  })
}

export interface DepositResult {
  signature: string
  blinding: Uint8Array
  assetId: string // hex, 32 bytes (all-zero = native SOL)
  amount: bigint
}

// ---- SPL re-shield (#779) --------------------------------------------------

function assetVaultPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(ASSET_VAULT_SEED), mint.toBytes()],
    programId
  )[0]
}

function assetConfigPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(ASSET_CONFIG_SEED), mint.toBytes()],
    programId
  )[0]
}

// The associated token account of `owner` for `mint`, derived without
// @solana/spl-token (the extension bundles only web3.js): ATA =
// findProgramAddress([owner, tokenProgram, mint], associatedTokenProgram).
export function associatedTokenAddress(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey = new PublicKey(TOKEN_PROGRAM_ID)
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID)
  )[0]
}

// Layout: DEPOSIT_NOTE_SPL discriminator (8) | amount u64 LE (8) | pubkey (32) |
// blinding (32) — identical arg shape to deposit_note, just the SPL variant.
function depositSplInstructionData(
  amount: bigint,
  pubkey: Uint8Array,
  blinding: Uint8Array
): Buffer {
  const data = new Uint8Array(8 + 8 + 32 + 32)
  data.set(DEPOSIT_NOTE_SPL_DISCRIMINATOR, 0)
  new DataView(data.buffer).setBigUint64(8, amount, true)
  data.set(pubkey, 16)
  data.set(blinding, 48)
  return Buffer.from(data)
}

// Build a `deposit_note_spl` instruction. Account order mirrors the on-chain
// DepositNoteSpl struct exactly: bridge_state, asset_config, mint, asset_vault,
// depositor_token_account, merkle_tree, depositor, token_program.
export function buildDepositSplInstruction(
  depositor: PublicKey,
  mint: PublicKey,
  depositorTokenAccount: PublicKey,
  amount: bigint,
  pubkey: Uint8Array,
  blinding: Uint8Array,
  tokenProgram: PublicKey = new PublicKey(TOKEN_PROGRAM_ID)
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: bridgeStatePda(), isSigner: false, isWritable: false },
      { pubkey: assetConfigPda(mint), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: assetVaultPda(mint), isSigner: false, isWritable: true },
      { pubkey: depositorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: merkleTreePda(), isSigner: false, isWritable: true },
      { pubkey: depositor, isSigner: true, isWritable: true },
      { pubkey: tokenProgram, isSigner: false, isWritable: false }
    ],
    data: depositSplInstructionData(amount, pubkey, blinding)
  })
}

// Re-shield `amount` base units of `mint` held at `depositor`'s associated
// token account into the shielded pool, crediting `shieldedAddress`. `depositor`
// is the (fresh) keypair that owns the tokens (e.g. a private-swap output
||
// address). The blinding is returned so the caller can persist the note for a
// later SPL spend. `assetId` is `mint_to_asset(mint)`.
export async function depositSpl(
  connection: Connection,
  depositor: Keypair,
  shieldedAddress: string,
  mint: PublicKey,
  amount: bigint,
  assetId: string,
  tokenProgram: PublicKey = new PublicKey(TOKEN_PROGRAM_ID),
  onSubmitted?: (result: DepositResult) => Promise<void>
): Promise<DepositResult> {
  const recipient = hexToBytes(addressSpendPubHex(shieldedAddress))
  const blinding = new Uint8Array(32)
  crypto.getRandomValues(blinding)

  const ata = associatedTokenAddress(depositor.publicKey, mint, tokenProgram)
  const ix = buildDepositSplInstruction(
    depositor.publicKey,
    mint,
    ata,
    amount,
    recipient,
    blinding,
    tokenProgram
  )
  const tx = new Transaction().add(ix)
  const { blockhash } = await connection.getLatestBlockhash("confirmed")
  tx.recentBlockhash = blockhash
  tx.feePayer = depositor.publicKey
  tx.sign(depositor)

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    maxRetries: 5
  })
  const result = { signature, blinding, assetId, amount }
  if (onSubmitted) {
    try {
      await onSubmitted(result)
    } catch {}
  }
  await confirmBySignatureStatus(connection, signature)
  return result
}

export function buildCreateAtaIdempotentInstruction(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey = new PublicKey(TOKEN_PROGRAM_ID)
): TransactionInstruction {
  const ata = associatedTokenAddress(owner, mint, tokenProgram)
  return new TransactionInstruction({
    programId: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false }
    ],
    data: Buffer.from([1])
  })
}

export async function confirmBySignatureStatus(
  connection: Connection,
  signature: string,
  timeoutMs = 90_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const st = await connection.getSignatureStatus(signature, {
        searchTransactionHistory: true
      })
      const v = st.value
      if (v) {
        if (v.err) {
          throw new Error(`transaction failed on-chain: ${JSON.stringify(v.err)}`)
        }
        if (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized") {
          return true
        }
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("transaction failed on-chain")) {
        throw e
      }
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

export async function createTokenAccount(
  connection: Connection,
  payer: Keypair,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey = new PublicKey(TOKEN_PROGRAM_ID)
): Promise<PublicKey> {
  const ata = associatedTokenAddress(owner, mint, tokenProgram)
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await connection.getAccountInfo(ata, "confirmed")) return ata
    try {
      const ix = buildCreateAtaIdempotentInstruction(
        payer.publicKey,
        owner,
        mint,
        tokenProgram
      )
      const tx = new Transaction().add(ix)
      const { blockhash } = await connection.getLatestBlockhash("confirmed")
      tx.recentBlockhash = blockhash
      tx.feePayer = payer.publicKey
      tx.sign(payer)
      const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 5 })
      if (await confirmBySignatureStatus(connection, sig)) return ata
    } catch {}
  }
  if (await connection.getAccountInfo(ata, "confirmed")) return ata
  throw new Error("ATA creation did not confirm after retries")
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"))
}

export function solanaAddressToBytes(address: string): Uint8Array {
  return new PublicKey(address).toBytes()
}

export async function deposit(
  connection: Connection,
  wallet: WalletKeyPair,
  amountLamports: bigint
): Promise<DepositResult> {
  const signer = Keypair.fromSecretKey(wallet.secretKey)
  const recipient = hexToBytes(addressSpendPubHex(wallet.shieldedAddress))
  const randomness = new Uint8Array(32)
  crypto.getRandomValues(randomness)

  const ix = buildDepositInstruction(signer.publicKey, amountLamports, recipient, randomness)
  const tx = new Transaction().add(ix)
  const { blockhash } = await connection.getLatestBlockhash("confirmed")
  tx.recentBlockhash = blockhash
  tx.feePayer = signer.publicKey
  tx.sign(signer)

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    maxRetries: 5
  })
  const assetId = NATIVE_ASSET_HEX
  const result = { signature, blinding: randomness, assetId, amount: amountLamports }
  await confirmBySignatureStatus(connection, signature)
  return result
}
