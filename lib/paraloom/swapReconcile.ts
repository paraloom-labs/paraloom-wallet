// Reconcile stranded private-swap rows against on-chain reality so the Activity
// feed stops showing swaps as "Pending" forever. A swap row is saved early (with
// an empty swapSignature) so its fresh-address key can never be lost; the second
// write that fills in the realized amount + signature is what marks it done. If
// that second write is lost (the service worker slept, the page timed out), the
// row is stuck pending even though the money is safe. This resolves each such row
// to its true outcome:
//
//   - resume:     the fresh address still holds the withdrawn SOL and the swap
//                 leg never ran → finish the swap (idempotent: the input note was
//                 already consumed by the settled withdraw, so no double-spend).
//   - landed:     the swap already ran and the bought token sits at the fresh
//                 address, only the local record was lost → record it as done.
//   - unresolved: nothing recoverable at the fresh address. Either the swap
//                 completed and re-shielded (funds back in the pool) or the
//                 withdraw never settled (input note still safe). Left untouched
//                 for the user to dismiss manually — we never auto-close a row we
//                 cannot positively account for, so a transient RPC blip can never
//                 hide a genuinely recoverable strand.

import { Connection, PublicKey } from "@solana/web3.js"

import {
  isNativeSolOutput,
  resumeSwapAtFreshAddress,
  resumeTokenSwapAtFreshAddress
} from "./privateSwap"
import { persistReshieldedNote } from "./reshieldRecovery"
import {
  classifyStrand,
  isTokenInput,
  RESUME_GRACE_MS,
  RESUME_MIN_LAMPORTS
} from "./swapReconcileClassify"
import { listSwapOutputs, saveSwapOutput } from "./swapOutputs"

export { classifyStrand, isTokenInput, RESUME_GRACE_MS, RESUME_MIN_LAMPORTS }
export type { StrandAction } from "./swapReconcileClassify"

let reconcileInFlight = false

/// Resolve every stranded swap row for `shieldedAddress` to its true on-chain
/// outcome. Best-effort and idempotent: a row it cannot positively account for is
/// left as-is. Returns the number of rows it moved out of the pending state.
export async function reconcileSwapOutputs(
  connection: Connection,
  shieldedAddress: string
): Promise<number> {
  if (reconcileInFlight) return 0
  reconcileInFlight = true
  let resolved = 0
  try {
    const outputs = await listSwapOutputs()
    const now = Date.now()
    for (const o of outputs) {
      if (o.swapSignature) continue
      if (now - o.createdAt < RESUME_GRACE_MS) continue

      const freshPub = new PublicKey(o.freshAddress)
      let solLamports = 0n
      try {
        solLamports = BigInt(await connection.getBalance(freshPub))
      } catch {
        continue // RPC blip: retry on the next open rather than guess
      }

      const tokenInput = isTokenInput(o.inputMint)
      let inputTokenAmount = 0n
      if (tokenInput && o.inputMint) {
        try {
          const inAccts = await connection.getParsedTokenAccountsByOwner(freshPub, {
            mint: new PublicKey(o.inputMint)
          })
          inputTokenAmount = inAccts.value.reduce(
            (s, a) =>
              s +
              BigInt(
                (a.account.data as { parsed: { info: { tokenAmount: { amount: string } } } })
                  .parsed.info.tokenAmount.amount
              ),
            0n
          )
        } catch {
          // no token account yet or RPC error
        }
      }

      let tokenAmount = 0n
      if (!isNativeSolOutput(o.outputMint)) {
        const shouldCheckOutputToken = tokenInput
          ? inputTokenAmount === 0n
          : solLamports <= RESUME_MIN_LAMPORTS

        if (shouldCheckOutputToken) {
          try {
            const accts = await connection.getParsedTokenAccountsByOwner(freshPub, {
              mint: new PublicKey(o.outputMint)
            })
            tokenAmount = accts.value.reduce(
              (s, a) =>
                s +
                BigInt(
                  (a.account.data as { parsed: { info: { tokenAmount: { amount: string } } } })
                    .parsed.info.tokenAmount.amount
                ),
              0n
            )
          } catch {
            // no token account yet — leave as unresolved below
          }
        }
      }

      let action = classifyStrand({
        hasSignature: false,
        ageMs: now - o.createdAt,
        solLamports,
        tokenAmount,
        isTokenInput: tokenInput,
        inputTokenAmount
      })

      // For legacy SOL-input swaps missing inputMint: A "SOL" output means this was a
      // token -> SOL swap: the SOL at the fresh address is the OUTPUT, never a SOL input to
      // swap again, so never resume it. (For token-input swaps, leftover gas SOL is NEVER
      // mistaken for landed output).
      if (!tokenInput && action === "resume" && isNativeSolOutput(o.outputMint)) {
        action = "landed"
        tokenAmount = solLamports
      }

      if (action === "resume") {
        try {
          if (tokenInput && o.inputMint) {
            const r = await resumeTokenSwapAtFreshAddress(
              connection,
              shieldedAddress,
              o.freshSecretKeyHex,
              o.inputMint,
              o.outputMint,
              o.reshield ?? false,
              (note) => persistReshieldedNote(shieldedAddress, note)
            )
            await saveSwapOutput({
              ...o,
              outAmount: r.outAmount,
              swapSignature: r.swapSignature
            })
            if (r.reshielded) {
              await persistReshieldedNote(shieldedAddress, r.reshielded)
            }
            resolved++
          } else {
            const r = await resumeSwapAtFreshAddress(
              connection,
              shieldedAddress,
              o.freshSecretKeyHex,
              o.outputMint,
              o.reshield ?? false,
              (note) => persistReshieldedNote(shieldedAddress, note)
            )
            await saveSwapOutput({
              ...o,
              outAmount: r.outAmount,
              swapSignature: r.swapSignature
            })
            if (r.reshielded) {
              await persistReshieldedNote(shieldedAddress, r.reshielded)
            }
            resolved++
          }
        } catch (e) {
          console.log(
            `[paraloom] could not resume swap at ${o.freshAddress}: ${
              e instanceof Error ? e.message : String(e)
            }`
          )
        }
      } else if (action === "landed") {
        try {
          // The swap already landed; the fresh address holds the bought token.
          // Record the realized amount and the tx that put it there so the row
          // resolves and links to the explorer. No re-shield here: the fresh
          // address has no gas SOL left to pay for it, and the token stays
          // recoverable at the address the wallet still holds the key for.
          const sigs = await connection.getSignaturesForAddress(freshPub, { limit: 1 })
          const sig = sigs[0]?.signature
          if (!sig) continue // cannot attest it landed → leave for manual dismiss
          await saveSwapOutput({
            ...o,
            outAmount: Number(tokenAmount),
            swapSignature: sig
          })
          resolved++
        } catch (e) {
          console.log(
            `[paraloom] could not record landed swap at ${o.freshAddress}: ${
              e instanceof Error ? e.message : String(e)
            }`
          )
        }
      }
      // "unresolved" / "skip": leave untouched.
    }
  } finally {
    reconcileInFlight = false
  }
  return resolved
}
