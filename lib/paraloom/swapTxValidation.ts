// Validate a router-supplied swap transaction BEFORE the fresh key signs it.
//
// paraloom-wallet#300: every private-swap path fetched an unsigned serialized
// transaction from the routing service and signed it verbatim. The router
// authors the message, so a malicious or compromised router (or an on-path
// response) could return a transaction that drains the fresh address — e.g. a
// `SystemProgram.transfer` / SPL `transferChecked` of the whole withdrawn
// balance to an attacker account — and the wallet would happily sign and
// broadcast it. The module doc's "the router only ever sees a public key"
// reasoning is incomplete: the relayer does not need to sign anything.
//
// This module breaks that chain with two layers, both fail-closed:
//   1. `validateSwapTransaction` — pure, offline checks on the decoded message:
//      the fresh key is the ONLY required signer (and the fee payer); every
//      instruction belongs to a small allowlist (Jupiter aggregator v6, SPL
//      Token, Associated Token, System, Compute Budget); a System transfer is
//      only the SOL->wSOL wrap into the fresh address's own wSOL ATA; a
//      top-level SPL transfer is never allowed (token movement must happen
//      inside the Jupiter instruction via CPI, where the aggregator enforces
//      the swap); `syncNative`/`closeAccount` only touch the fresh wSOL ATA;
//      and at least one Jupiter instruction must be present.
//   2. `verifySwapSimulation` — simulate the unsigned transaction and assert
//      the fresh address's output-token account actually receives at least the
//      quoted amount minus slippage. A drain, a wrong mint, or a manipulated
//      route shows up here as a missing/short output balance.
//
// Both layers run inside `validateAndSignSwapTransaction`, which is the only
// path the swap legs use to sign a router-built transaction. Kept free of
// heavy imports (prover / wasm / chrome) so it is unit-testable in isolation.

import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction
} from "@solana/web3.js"

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID
} from "./constants"
import { isNativeSolOutput, WSOL_MINT } from "./swapReconcileClassify"

/** Jupiter Aggregator v6 — the program the routing service builds swaps with. */
export const JUPITER_AGGREGATOR_V6_PROGRAM_ID =
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
export const COMPUTE_BUDGET_PROGRAM_ID =
  "ComputeBudget111111111111111111111111111111"
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111"

// SPL Token program instruction discriminators (first byte of the data).
const TOKEN_TRANSFER = 3
const TOKEN_APPROVE = 4
const TOKEN_CLOSE_ACCOUNT = 9
const TOKEN_TRANSFER_CHECKED = 12
const TOKEN_SYNC_NATIVE = 17

/** SPL Token account layout: mint (32) | owner (32) | amount u64 LE at 64. */
const TOKEN_ACCOUNT_DATA_LEN = 165
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64

export interface SwapTxExpectations {
  /** The fresh ephemeral key that will sign — the only permitted signer. */
  fresh: PublicKey
  /** Input mint: "SOL" (native) or an SPL mint (base58). */
  inputMint: string
  /** Input amount in the input mint's base units (lamports for SOL). */
  inputAmount: bigint
  /** Output mint: "SOL" or an SPL mint (base58). */
  outputMint: string
  /** Router-quoted output amount in the output mint's base units. */
  quotedOutAmount: number
  /** Max slippage in bps (default 100 = 1%). */
  slippageBps?: number
}

/** Associated token address for `owner`/`mint` (mirrors bridge.ts). */
export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBytes(), new PublicKey(TOKEN_PROGRAM_ID).toBytes(), mint.toBytes()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID)
  )[0]
}

function fail(message: string): never {
  throw new Error(`refusing to sign router swap transaction: ${message}`)
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  let value = 0n
  for (let i = 0; i < 8; i++) {
    value |= BigInt(data[offset + i] ?? 0) << BigInt(8 * i)
  }
  return value
}

function readU32LE(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] ?? 0) |
      ((data[offset + 1] ?? 0) << 8) |
      ((data[offset + 2] ?? 0) << 16) |
      ((data[offset + 3] ?? 0) << 24)) >>>
    0
  )
}

/**
 * Pure validation of a router-built swap transaction. Throws on the first
 * violated invariant; returns silently when the message is a swap of exactly
 * `expected.inputAmount` of `expected.inputMint` into `expected.outputMint`
 * that only the fresh key can authorize.
 *
 * `addressLookupTableAccounts` must contain the lookup tables referenced by
 * `tx.message.addressTableLookups` (pass [] when the message uses none).
 */
export function validateSwapTransaction(
  tx: VersionedTransaction,
  expected: SwapTxExpectations,
  addressLookupTableAccounts: AddressLookupTableAccount[] = []
): void {
  const { fresh, inputMint, inputAmount, outputMint } = expected
  const message = tx.message
  const keys = message.getAccountKeys({ addressLookupTableAccounts })
  const keyAt = (index: number, what: string): PublicKey => {
    const key = keys.get(index)
    if (!key) fail(`unresolved account index ${index} (${what})`)
    return key as PublicKey
  }

  // 1. Only the fresh key may sign, and it must pay the fee. Any other
  //    required signer means the router is asking us to co-sign something
  //    else's authority (or to authorize a second account's funds).
  if (message.header.numRequiredSignatures !== 1) {
    fail(
      `expected exactly 1 required signer (the fresh address), got ${message.header.numRequiredSignatures}`
    )
  }
  if (!keyAt(0, "fee payer").equals(fresh)) {
    fail("fee payer is not the fresh address")
  }

  const inputMintPk = isNativeSolOutput(inputMint)
    ? new PublicKey(WSOL_MINT)
    : new PublicKey(inputMint)
  // The input token enters the swap from the fresh address's ATA for the
  // input mint (its wSOL ATA when the input is native SOL).
  const inputAta = associatedTokenAddress(fresh, inputMintPk)
  const wsolAta = associatedTokenAddress(fresh, new PublicKey(WSOL_MINT))

  const allowedPrograms = new Set([
    SYSTEM_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    COMPUTE_BUDGET_PROGRAM_ID,
    JUPITER_AGGREGATOR_V6_PROGRAM_ID
  ])

  let sawJupiter = false
  for (const ix of message.compiledInstructions) {
    const programId = keyAt(ix.programIdIndex, "program id")
    const programIdStr = programId.toBase58()
    if (!allowedPrograms.has(programIdStr)) {
      fail(`instruction calls non-allowlisted program ${programIdStr}`)
    }
    const account = (i: number, what: string): PublicKey =>
      keyAt(ix.accountKeyIndexes[i] as number, what)

    if (programIdStr === JUPITER_AGGREGATOR_V6_PROGRAM_ID) {
      // The actual swap. Its data is aggregator-internal, so presence plus
      // the transfer-shape rules below and the simulation layer are what
      // bind it to the requested route.
      sawJupiter = true
      continue
    }

    if (programIdStr === COMPUTE_BUDGET_PROGRAM_ID) continue

    if (programIdStr === ASSOCIATED_TOKEN_PROGRAM_ID) {
      // createAssociatedTokenAccount: [payer, ata, owner, mint, system, token].
      // The router may only create accounts owned by the fresh address.
      if (ix.accountKeyIndexes.length < 3 || !account(2, "ata owner").equals(fresh)) {
        fail("associated-token-account instruction not owned by the fresh address")
      }
      continue
    }

    if (programIdStr === SYSTEM_PROGRAM_ID) {
      // SystemProgram.transfer = 2, data = u32 ix + u64 lamports.
      // The only legitimate system transfer in a Jupiter swap is wrapping
      // exactly the swap input into the fresh address's own wSOL ATA. Any
      // other destination — or a larger amount — is the drain / over-swap.
      if (ix.data.length < 12 || readU32LE(ix.data, 0) !== 2) {
        fail("non-transfer system instruction in router transaction")
      }
      if (!account(0, "transfer source").equals(fresh)) {
        fail("system transfer source is not the fresh address")
      }
      if (!account(1, "transfer destination").equals(wsolAta)) {
        fail("system transfer destination is not the fresh address's wSOL account")
      }
      if (readU64LE(ix.data, 4) !== inputAmount) {
        fail("system transfer amount is not the swap input amount")
      }
      continue
    }

    // SPL Token program.
    const discriminator = ix.data[0]
    if (discriminator === TOKEN_TRANSFER || discriminator === TOKEN_TRANSFER_CHECKED) {
      // A top-level token transfer is exactly the drain primitive: the
      // Jupiter instruction moves tokens via CPI, so a legitimate swap has
      // no top-level transfer at all. Reject regardless of amount or
      // destination — even an "exact input amount" transfer to an attacker
      // account would pass an amount check.
      fail("top-level token transfer in router transaction")
    }
    if (discriminator === TOKEN_APPROVE) {
      // Approve (data: u8 ix + u64 amount; accounts: [source, delegate, owner]).
      // Only ever approve the Jupiter program to spend exactly the input
      // amount from the fresh input ATA.
      if (ix.data.length < 9) fail("malformed approve instruction")
      if (readU64LE(ix.data, 1) !== inputAmount) {
        fail("approve amount is not the swap input amount")
      }
      if (!account(0, "approve source").equals(inputAta)) {
        fail("approve source is not the fresh address's input token account")
      }
      if (!account(1, "approve delegate").equals(new PublicKey(JUPITER_AGGREGATOR_V6_PROGRAM_ID))) {
        fail("approve delegate is not the Jupiter aggregator")
      }
      if (!account(2, "approve owner").equals(fresh)) {
        fail("approve owner is not the fresh address")
      }
      continue
    }
    if (discriminator === TOKEN_SYNC_NATIVE) {
      // syncNative (data: u8 ix; accounts: [token account]). Only the fresh
      // wSOL ATA may be synced (the wrap step of a SOL-input swap).
      if (!account(0, "syncNative account").equals(wsolAta)) {
        fail("syncNative on an account other than the fresh wSOL account")
      }
      continue
    }
    if (discriminator === TOKEN_CLOSE_ACCOUNT) {
      // closeAccount (data: u8 ix; accounts: [account, destination, owner]).
      // Only closing the fresh wSOL ATA back to the fresh address (unwrap).
      if (!account(0, "closeAccount account").equals(wsolAta)) {
        fail("closeAccount on an account other than the fresh wSOL account")
      }
      if (!account(1, "closeAccount destination").equals(fresh)) {
        fail("closeAccount destination is not the fresh address")
      }
      if (!account(2, "closeAccount owner").equals(fresh)) {
        fail("closeAccount owner is not the fresh address")
      }
      continue
    }
    fail(`disallowed token instruction ${discriminator} in router transaction`)
  }

  if (!sawJupiter) {
    fail("no Jupiter aggregator instruction — not a swap")
  }
}

/**
 * Simulate the (still unsigned) swap transaction and assert the output
 * actually lands: the fresh address's output-token account must hold at
 * least the quoted amount minus slippage. Catches a wrong mint, a
 * manipulated route, or a drain that the message-shape checks could not see
 * (e.g. a crafted Jupiter instruction). Fail-closed: any simulation error,
 * missing account, or short balance throws.
 */
export async function verifySwapSimulation(
  connection: Connection,
  tx: VersionedTransaction,
  expected: SwapTxExpectations
): Promise<void> {
  const { fresh, outputMint, quotedOutAmount } = expected
  const slippageBps = expected.slippageBps ?? 100
  const outputMintPk = isNativeSolOutput(outputMint)
    ? new PublicKey(WSOL_MINT)
    : new PublicKey(outputMint)
  const outputAta = associatedTokenAddress(fresh, outputMintPk)

  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false,
    commitment: "confirmed",
    accounts: { encoding: "base64", addresses: [outputAta.toBase58()] }
  })
  if (sim.value.err) {
    fail(`swap simulation failed on-chain: ${JSON.stringify(sim.value.err)}`)
  }
  const account = sim.value.accounts?.[0]
  if (!account) {
    fail("swap simulation returned no output token account")
  }
  const data = Buffer.from(account.data[0] as string, "base64")
  if (data.length < TOKEN_ACCOUNT_DATA_LEN) {
    fail("swap simulation output account data is not a token account")
  }
  const received = readU64LE(data, TOKEN_ACCOUNT_AMOUNT_OFFSET)
  const minExpected =
    (BigInt(Math.floor(quotedOutAmount)) * BigInt(10_000 - slippageBps)) / 10_000n
  if (received < minExpected) {
    fail(
      `simulated output ${received} is below the quoted ${quotedOutAmount} minus ${slippageBps} bps slippage (min ${minExpected})`
    )
  }
}

/**
 * Validate a router-built swap transaction (message shape + simulation) and
 * sign it with the fresh key. Throws before signing on any violation, so a
 * malicious router response can never reach `sendRawTransaction`.
 */
export async function validateAndSignSwapTransaction(
  connection: Connection,
  tx: VersionedTransaction,
  fresh: Keypair,
  expected: SwapTxExpectations
): Promise<void> {
  // Resolve address lookup tables the message references, so the validator
  // sees the full account list (Jupiter routes commonly use them).
  const lookupTables: AddressLookupTableAccount[] = []
  for (const lookup of tx.message.addressTableLookups) {
    const res = await connection.getAddressLookupTable(lookup.accountKey)
    if (!res.value) {
      fail(`address lookup table ${lookup.accountKey.toBase58()} not found`)
    }
    lookupTables.push(res.value)
  }
  validateSwapTransaction(tx, expected, lookupTables)
  await verifySwapSimulation(connection, tx, expected)
  tx.sign([fresh])
}
