// Private swap-out outputs. A private swap leaves the bought token at a FRESH,
// unlinkable address whose key the wallet generated. That key never leaves the
// wallet, so it must be persisted here or the token would be unrecoverable.
// Stored in extension-local storage (not synced).

export interface SwapOutput {
  /** The fresh, unlinkable address holding the swapped token. */
  freshAddress: string
  /** Secret key (hex) of the fresh address — needed to move the token later. */
  freshSecretKeyHex: string
  /** Output mint (base58) or "SOL". */
  outputMint: string
  /** Output amount the route reported, in the out mint's base units. */
  outAmount: number
  /** Confirmed swap transaction signature. */
  swapSignature: string
  /** A submitted transaction is not complete until confirmed. */
  submittedSignature?: string
  /** Recent blockhash used by the submitted transaction, for safe retry gating. */
  submittedBlockhash?: string
  /** Router quote retained while the submitted signature is pending. */
  submittedOutAmount?: number
  /** Input asset used to recover an unconfirmed submission. */
  inputMint?: string
  inputAmount?: string
  /** Set only after confirmation is observed locally or by reconciliation. */
  confirmedAt?: number
  /** Whether the user asked to re-shield the bought token (a round trip). Saved
   *  so a resumed/recovered swap honors the original intent. */
  reshield?: boolean
  /** Set once the re-shield note has been persisted (either normally or via the
   *  recovery scan), so recovery does not re-scan a settled reshield each connect. */
  reshieldRecovered?: boolean
  createdAt: number
}

export function isSwapOutputConfirmed(output: SwapOutput): boolean {
  return output.outAmount > 0 && !!output.swapSignature && !!output.confirmedAt
}

const KEY = "paraloom_swap_outputs"

// Upsert by freshAddress: the key is saved early (before the withdraw) so it can
// never be lost, then the same entry is updated with the realized amount +
// signature once the swap lands. Keyed on the address so the two writes collapse
// to one row.
export async function saveSwapOutput(output: SwapOutput): Promise<void> {
  const stored = await chrome.storage.local.get(KEY)
  const current = (stored[KEY] as SwapOutput[]) ?? []
  const i = current.findIndex((o) => o.freshAddress === output.freshAddress)
  if (i >= 0) current[i] = { ...current[i], ...output }
  else current.push(output)
  await chrome.storage.local.set({ [KEY]: current })
}

export async function listSwapOutputs(): Promise<SwapOutput[]> {
  const stored = await chrome.storage.local.get(KEY)
  return (stored[KEY] as SwapOutput[]) ?? []
}

// Drop a swap row by its fresh address. Used to clear a stale "pending" row the
// reconciler could not positively account for — the funds are already safe (the
// swap either re-shielded into the pool or its input note was never spent), so
// this only removes the misleading Activity entry, never any money.
export async function dismissSwapOutput(freshAddress: string): Promise<void> {
  const stored = await chrome.storage.local.get(KEY)
  const current = (stored[KEY] as SwapOutput[]) ?? []
  const next = current.filter((o) => o.freshAddress !== freshAddress)
  await chrome.storage.local.set({ [KEY]: next })
}
