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
import { listSwapOutputs, saveSwapOutput } from "./swapOutputs"
import { classifyStrand, RESUME_GRACE_MS, RESUME_MIN_LAMPORTS } from "./swapReconcileClassify"

export { classifyStrand, RESUME_GRACE_MS, RESUME_MIN_LAMPORTS }
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
      if (now - o.createdAt < RESUME_GRACE_MS) continue
      let row = o
      const submittedSignature = o.submittedSignature || o.swapSignature
      if (submittedSignature) {
        try {
          const status = await connection.getSignatureStatus(submittedSignature, {
            searchTransactionHistory: true
          })
          if (
            status.value?.confirmationStatus === "confirmed" ||
            status.value?.confirmationStatus === "finalized"
          ) {
            if (!status.value.err) {
              await saveSwapOutput({
                ...o,
                outAmount: o.submittedOutAmount || o.outAmount,
                swapSignature: submittedSignature,
                submittedSignature: "",
                submittedBlockhash: "",
                submittedOutAmount: 0,
                confirmedAt: Date.now()
              })
              resolved++
              continue
            }
          } else if (status.value) {
            continue
          }
          if (!status.value && row.submittedBlockhash) {
            const validity = await connection.isBlockhashValid(row.submittedBlockhash, "confirmed")
            if (validity.value) continue
          }
          row = {
            ...o,
            outAmount: 0,
            swapSignature: "",
            submittedSignature: "",
            submittedBlockhash: "",
            submittedOutAmount: 0,
            confirmedAt: 0
          }
          await saveSwapOutput(row)
        } catch {
          continue
        }
      }

      const freshPub = new PublicKey(row.freshAddress)
      let solLamports = 0n
      try {
        solLamports = BigInt(await connection.getBalance(freshPub))
      } catch {
        continue // RPC blip: retry on the next open rather than guess
      }

      let tokenAmount = 0n
      if (!isNativeSolOutput(row.outputMint)) {
        try {
          const accts = await connection.getParsedTokenAccountsByOwner(freshPub, {
            mint: new PublicKey(row.outputMint)
          })
          tokenAmount = accts.value.reduce(
            (s, a) =>
              s +
              BigInt(
                (a.account.data as { parsed: { info: { tokenAmount: { amount: string } } } }).parsed
                  .info.tokenAmount.amount
              ),
            0n
          )
        } catch {
          // no token account yet — leave as unresolved below
        }
      }

      let inputTokenAmount = 0n
      if (row.inputMint && row.inputMint !== "unknown" && !isNativeSolOutput(row.inputMint)) {
        try {
          const accts = await connection.getParsedTokenAccountsByOwner(freshPub, {
            mint: new PublicKey(row.inputMint)
          })
          inputTokenAmount = accts.value.reduce(
            (s, a) =>
              s +
              BigInt(
                (a.account.data as { parsed: { info: { tokenAmount: { amount: string } } } }).parsed
                  .info.tokenAmount.amount
              ),
            0n
          )
        } catch {
          // No input token account means there is no safely recoverable input.
        }
      }

      let action = classifyStrand({
        hasSignature: false,
        hasSubmittedSignature: !!submittedSignature,
        ageMs: now - row.createdAt,
        solLamports,
        tokenAmount,
        inputMint: row.inputMint ?? "unknown",
        inputTokenAmount
      })

      // A "SOL" output means this was a token -> SOL swap (or its stranded gas
      // leg): the SOL at the fresh address is the OUTPUT, never a SOL input to
      // swap again, so never resume it (that would route SOL -> SOL). Record the
      // SOL as landed instead; it is real and recoverable with the saved key.
      if (action === "resume" && isNativeSolOutput(row.outputMint)) {
        action = "landed"
        tokenAmount = solLamports
      }

      if (action === "resume") {
        try {
          const r = await resumeSwapAtFreshAddress(
            connection,
            shieldedAddress,
            row.freshSecretKeyHex,
            row.outputMint,
            row.reshield ?? false,
            (note) => persistReshieldedNote(shieldedAddress, note),
            (signature, outAmount, blockhash) =>
              saveSwapOutput({
                ...row,
                submittedSignature: signature,
                submittedOutAmount: outAmount,
                submittedBlockhash: blockhash
              })
          )
          await saveSwapOutput({
            ...row,
            outAmount: r.outAmount,
            swapSignature: r.swapSignature,
            submittedSignature: "",
            submittedBlockhash: "",
            submittedOutAmount: 0,
            confirmedAt: Date.now()
          })
          if (r.reshielded) {
            await persistReshieldedNote(shieldedAddress, r.reshielded)
          }
          resolved++
        } catch (e) {
          console.log(
            `[paraloom] could not resume swap at ${o.freshAddress}: ${
              e instanceof Error ? e.message : String(e)
            }`
          )
        }
      } else if (action === "resume-token") {
        try {
          const r = await resumeTokenSwapAtFreshAddress(
            connection,
            row.freshSecretKeyHex,
            row.inputMint!,
            row.outputMint,
            (signature, outAmount, blockhash) =>
              saveSwapOutput({
                ...row,
                submittedSignature: signature,
                submittedOutAmount: outAmount,
                submittedBlockhash: blockhash
              })
          )
          await saveSwapOutput({
            ...row,
            outAmount: r.outAmount,
            swapSignature: r.swapSignature,
            submittedSignature: "",
            submittedBlockhash: "",
            submittedOutAmount: 0,
            confirmedAt: Date.now()
          })
          resolved++
        } catch (e) {
          console.log(
            "[paraloom] could not resume token swap at " +
              row.freshAddress +
              ": " +
              (e instanceof Error ? e.message : String(e))
          )
        }
      } else if (action === "landed") {
        try {
          // The swap already landed; the fresh address holds the bought token.
          // Record the realized amount and the tx that put it there so the row
          // resolves and links to the explorer. No re-shield here: the fresh
          // address has no gas SOL left to pay for it, and the token stays
          // recoverable at the address the wallet still holds the key for.
          const sigs = await connection.getSignaturesForAddress(freshPub, { limit: 10 })
          const checks = await Promise.all(
            sigs.map(async ({ signature }) => {
              const status = await connection.getSignatureStatus(signature, {
                searchTransactionHistory: true
              })
              return status.value?.err == null &&
                (status.value?.confirmationStatus === "confirmed" ||
                  status.value?.confirmationStatus === "finalized")
                ? signature
                : ""
            })
          )
          const sig = checks.find(Boolean)
          if (!sig) continue // cannot attest it landed → leave for manual dismiss
          await saveSwapOutput({
            ...row,
            outAmount: Number(tokenAmount),
            swapSignature: sig,
            confirmedAt: Date.now()
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
