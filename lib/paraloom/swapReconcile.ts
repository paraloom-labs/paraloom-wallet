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
  resumeSwapFromTokenAtFreshAddress
} from "./privateSwap"
import { persistReshieldedNote } from "./reshieldRecovery"
import {
  classifyStrand,
  GAS_LAMPORTS,
  isTokenInputSwap,
  RESUME_GRACE_MS,
  RESUME_MIN_LAMPORTS
} from "./swapReconcileClassify"
import { listSwapOutputs, saveSwapOutput } from "./swapOutputs"

export {
  classifyStrand,
  isTokenInputSwap,
  GAS_LAMPORTS,
  RESUME_GRACE_MS,
  RESUME_MIN_LAMPORTS
}
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

      let isTokenInput = isTokenInputSwap(o.inputMint)
      let effectiveInputMint = o.inputMint

      let inputTokenAmount = 0n
      // Check input token ATA if this is a known token-input swap, or discover legacy rows (#855)
      if (effectiveInputMint && !isNativeSolOutput(effectiveInputMint)) {
        try {
          const accts = await connection.getParsedTokenAccountsByOwner(freshPub, {
            mint: new PublicKey(effectiveInputMint)
          })
          inputTokenAmount = accts.value.reduce(
            (s, a) =>
              s +
              BigInt(
                (a.account.data as { parsed: { info: { tokenAmount: { amount: string } } } })
                  .parsed.info.tokenAmount.amount
              ),
            0n
          )
        } catch {
          // RPC error / no account
        }
      } else if (!effectiveInputMint) {
        // Legacy row without inputMint: inspect whether freshPub owns any token accounts
        // other than outputMint (#855).
        try {
          const accts = await connection.getParsedTokenAccountsByOwner(freshPub, {
            programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
          })
          for (const a of accts.value) {
            const parsedInfo = (
              a.account.data as {
                parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } }
              }
            )?.parsed?.info
            const mint = parsedInfo?.mint
            const amt = BigInt(parsedInfo?.tokenAmount?.amount || "0")
            if (mint && !isNativeSolOutput(mint) && mint !== o.outputMint && amt > 0n) {
              isTokenInput = true
              effectiveInputMint = mint
              inputTokenAmount = amt
              break
            }
          }
        } catch {}
      }

      let outputTokenAmount = 0n
      if (!isNativeSolOutput(o.outputMint)) {
        try {
          const accts = await connection.getParsedTokenAccountsByOwner(freshPub, {
            mint: new PublicKey(o.outputMint)
          })
          outputTokenAmount = accts.value.reduce(
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

      let action = classifyStrand({
        hasSignature: false,
        ageMs: now - o.createdAt,
        solLamports,
        tokenAmount: outputTokenAmount,
        inputTokenAmount,
        isTokenInput
      })

      if (action === "resume") {
        try {
          if (isTokenInput && effectiveInputMint) {
            const r = await resumeSwapFromTokenAtFreshAddress(
              connection,
              shieldedAddress,
              o.freshSecretKeyHex,
              effectiveInputMint,
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
          } else if (!isTokenInput) {
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
          // The swap already landed; the fresh address holds the bought token/SOL.
          // Record the realized amount and the tx that put it there so the row
          // resolves and links to the explorer.
          const sigs = await connection.getSignaturesForAddress(freshPub, { limit: 1 })
          const sig = sigs[0]?.signature
          if (!sig) continue // cannot attest it landed → leave for manual dismiss
          const realizedOutAmount = isNativeSolOutput(o.outputMint)
            ? Number(solLamports)
            : Number(outputTokenAmount)
          await saveSwapOutput({
            ...o,
            outAmount: realizedOutAmount,
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
