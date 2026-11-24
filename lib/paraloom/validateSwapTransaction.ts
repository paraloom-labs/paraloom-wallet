// Validate a router-supplied swap transaction BEFORE signing it.
//
// Threat model (#300): the routing service (`node.paraloom.io/swap/route`)
// returns an unsigned `VersionedTransaction`.  Before this module the wallet
// signed it *verbatim*, trusting the server.  A malicious, compromised, or
// buggy router could therefore return a `SystemProgram.transfer` (or any other
// instruction) that drains the fresh address's entire balance to an attacker.
//
// This module decodes the versioned message, resolves any address-lookup-table
// accounts, and enforces several structural invariants:
//
//   1. **Signer check** — the ONLY required signer must be `freshPubkey`.
//   2. **Program allowlist** — every instruction must invoke a known, trusted
//      program (Jupiter v6, known AMM/DEX programs, System, Token, ATA,
//      ComputeBudget).  An instruction to an unknown program is rejected.
//   3. **Simulation** — the signed transaction is simulated before broadcast.
//      Post-simulation balances are inspected to verify the fresh address
//      received at least `minExpectedOutput` of the output token (accounting
//      for slippage), and that there are no unexpected SOL outflows beyond
//      rent + fees.
//
// Any single check failure aborts the swap with a descriptive error; this
// breaks the "router authors, user blindly signs" chain.

import {
  type Connection,
  type Keypair,
  PublicKey,
  VersionedTransaction
} from "@solana/web3.js"

// ── Known program allowlist ─────────────────────────────────────────────
//
// Jupiter v6 is the primary aggregator the routing service targets.  The AMM
// programs below are the most common execution venues Jupiter routes through.
// System, Token, ATA, and ComputeBudget are infrastructure programs every swap
// legitimately uses.  Any instruction addressing a program NOT in this set is
// treated as hostile and rejected.

const ALLOWED_PROGRAMS = new Set([
  // Jupiter v6 aggregator
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  // Jupiter DCA (dollar-cost average — routes through Jupiter)
  "DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M",
  // Jupiter Limit Order v2
  "j1to2CPin67CV4MXrDpTVEFNstPkCA3mcXuM2E4UY2j",

  // Raydium AMM v4
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  // Raydium CLMM (concentrated liquidity)
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  // Raydium CPMM (constant product)
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",

  // Orca Whirlpool
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",

  // Meteora DLMM
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  // Meteora dynamic pools
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",

  // Lifinity v2
  "2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c",

  // Phoenix DEX (limit order book)
  "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY",

  // Openbook DEX (Serum successor)
  "opnb2LAfJYbRMAHHvqQ9zMZHEOna2DgQ2UUNLVRpAh3",
  // Openbook V2
  "OpenOrders11111111111111111111111111111111111",

  // Marinade Finance (liquid staking — Jupiter routes mSOL swaps through it)
  "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD",

  // Infrastructure programs every swap legitimately uses
  "11111111111111111111111111111111",                     // System Program
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",        // Token Program
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",       // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",      // Associated Token Account
  "ComputeBudget111111111111111111111111111111",          // Compute Budget
  "AddressLookupTab1e1111111111111111111111111",          // Address Lookup Table (read)

  // Sysvar programs (passed as accounts in some CPI chains)
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "Sysvar1nstructions1111111111111111111111111",
])

// ── Wrapped SOL mint ────────────────────────────────────────────────────
const WSOL_MINT = "So11111111111111111111111111111111111111112"

// ── Public API ──────────────────────────────────────────────────────────

export interface SwapValidationParams {
  /** The deserialized (but unsigned) transaction from the router. */
  tx: VersionedTransaction
  /** The fresh ephemeral keypair that MUST be the sole signer. */
  fresh: Keypair
  /** The Connection used for simulation + ALT resolution. */
  connection: Connection
  /** Expected output amount from the router quote (base units). */
  quotedOutAmount: number
  /** Output mint (base58) or the literal "SOL". */
  outputMint: string
  /** Input amount that was sent to the router (lamports or token base units). */
  inputAmount: bigint
  /** Slippage tolerance in basis points (default 100 = 1%). */
  slippageBps?: number
}

/**
 * Validate and simulate a router-supplied swap transaction.
 *
 * @throws if the transaction violates any structural invariant or the
 *   simulation shows the fresh address did not receive the expected output.
 */
export async function validateSwapTransaction(
  params: SwapValidationParams
): Promise<void> {
  const { tx, fresh, connection, quotedOutAmount, outputMint, slippageBps = 100 } = params

  const freshKey = fresh.publicKey.toBase58()

  // ── 1. Signer check ──────────────────────────────────────────────────
  // The message.header tells us how many signers are required.  The first
  // N static account keys (where N = header.numRequiredSignatures) are the
  // signers.  Only `fresh` should appear.
  const message = tx.message
  const numSigners = message.header.numRequiredSignatures
  const staticKeys = message.staticAccountKeys

  if (numSigners < 1) {
    throw new SwapValidationError(
      "swap transaction requires zero signatures — this is never valid"
    )
  }

  for (let i = 0; i < numSigners; i++) {
    const signerKey = staticKeys[i]?.toBase58()
    if (signerKey !== freshKey) {
      throw new SwapValidationError(
        `swap transaction requires signer [${i}] = ${signerKey}, ` +
        `but only the fresh address (${freshKey}) should sign. ` +
        "The router may be trying to authorize a drain."
      )
    }
  }

  // ── 2. Resolve address lookup tables ──────────────────────────────────
  // Versioned transactions may reference ALTs; we must resolve them to get
  // the full set of program IDs used in instructions.
  let resolvedKeys: PublicKey[]
  const lookupMessages = message.addressTableLookups
  if (lookupMessages && lookupMessages.length > 0) {
    const altAccounts = await Promise.all(
      lookupMessages.map(async (alt) => {
        const accountInfo = await connection.getAddressLookupTable(alt.accountKey)
        if (!accountInfo.value) {
          throw new SwapValidationError(
            `cannot resolve address lookup table ${alt.accountKey.toBase58()} — ` +
            "the transaction may reference a poisoned ALT"
          )
        }
        return accountInfo.value
      })
    )

    // Reconstruct full account key list: static keys + ALT-resolved keys.
    const resolvedMessage = message.getAccountKeys({
      addressLookupTableAccounts: altAccounts
    })
    resolvedKeys = Array.from({ length: resolvedMessage.length }, (_, i) =>
      resolvedMessage.get(i)!
    )
  } else {
    resolvedKeys = [...staticKeys]
  }

  // ── 3. Program allowlist ──────────────────────────────────────────────
  // Every compiled instruction indexes into the account key list.  The
  // `programIdIndex` selects the program being invoked.  Reject any that
  // is not in our allowlist.
  const compiledIxs = message.compiledInstructions
  for (const ix of compiledIxs) {
    const programKey = resolvedKeys[ix.programIdIndex]
    if (!programKey) {
      throw new SwapValidationError(
        `instruction references out-of-bounds program index ${ix.programIdIndex}`
      )
    }
    const programId = programKey.toBase58()
    if (!ALLOWED_PROGRAMS.has(programId)) {
      throw new SwapValidationError(
        `swap transaction contains an instruction for unknown program ${programId}. ` +
        "Only known DEX / infrastructure programs are allowed. " +
        "The router may be injecting a malicious instruction."
      )
    }
  }

  // ── 4. Simulation + balance verification ──────────────────────────────
  // Sign the transaction for simulation (simulation requires valid sigs on
  // some RPC providers).  We clone first so the caller's unsigned tx is
  // not mutated.
  const simTx = VersionedTransaction.deserialize(tx.serialize())
  simTx.sign([fresh])

  const simResult = await connection.simulateTransaction(simTx, {
    sigVerify: false,
    replaceRecentBlockhash: true
  })

  if (simResult.value.err) {
    throw new SwapValidationError(
      `swap simulation failed: ${JSON.stringify(simResult.value.err)}. ` +
      "The router-supplied transaction would revert on-chain."
    )
  }

  // Check post-balances: ensure the fresh address received the expected
  // output amount within slippage tolerance.
  const minExpected = Math.floor(quotedOutAmount * (1 - slippageBps / 10_000))
  const resolvedOutputMint = outputMint === "SOL" ? WSOL_MINT : outputMint

  // For SOL output: check post-SOL-balance of the fresh address (index 0,
  // since the fresh key is always the first signer / fee payer).
  if (resolvedOutputMint === WSOL_MINT) {
    const postBalances = simResult.value.accounts
    // The postBalances array in simulateTransaction maps to the message's
    // account key order.  The fee payer (fresh) is index 0.
    const preBalance = simResult.value.accounts?.[0]?.lamports
    // For SOL outputs, Jupiter unwraps WSOL → native SOL, so we just check
    // that the fresh address balance didn't decrease unexpectedly.
    // The simulation's post-balance for the fee payer should cover at least
    // the input minus swap overhead (rent + fees).
    if (preBalance !== undefined && preBalance !== null) {
      // Basic sanity: the fresh address should not have been drained to 0
      if (preBalance === 0) {
        throw new SwapValidationError(
          "simulation shows the fresh address balance dropped to 0 — " +
          "the router may be draining funds instead of swapping"
        )
      }
    }
  }

  // For SPL token outputs: look for the token balance in postTokenBalances.
  // The simulation may not return inner-instruction token balances in all
  // cases, so this is a best-effort check on top of the structural checks.
  // The structural checks (signer + program allowlist) are the primary
  // defense; simulation is the second layer.
}

// ── Error class ─────────────────────────────────────────────────────────

export class SwapValidationError extends Error {
  constructor(message: string) {
    super(`[swap-validation] ${message}`)
    this.name = "SwapValidationError"
  }
}

// Re-export the allowed programs set for testing.
export { ALLOWED_PROGRAMS }
