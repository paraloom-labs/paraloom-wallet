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
  /** The swap transaction signature. Empty until the swap leg completes; a
   *  non-empty value marks the swap done (used to find resumable strands). */
  swapSignature: string
  /** Whether the user asked to re-shield the bought token (a round trip). Saved
   *  so a resumed/recovered swap honors the original intent. */
  reshield?: boolean
  /** Set once the re-shield note has been persisted (either normally or via the
   *  recovery scan), so recovery does not re-scan a settled reshield each connect. */
  reshieldRecovered?: boolean
  createdAt: number
}

const KEY = "paraloom_swap_outputs"

function readStoredList(stored: Record<string, unknown>): SwapOutput[] {
  const raw = stored[KEY]
  return Array.isArray(raw) ? (raw as SwapOutput[]) : []
}

// Upsert by freshAddress: the key is saved early (before the withdraw) so it can
// never be lost, then the same entry is updated with the realized amount +
// signature once the swap lands. Keyed on the address so the two writes collapse
// to one row.
export async function saveSwapOutput(output: SwapOutput): Promise<void> {
  if (!output || typeof output.freshAddress !== "string" || !output.freshAddress.trim()) {
    throw new Error("saveSwapOutput: freshAddress must be a non-empty string")
  }
  if (!Number.isFinite(output.outAmount) || output.outAmount < 0) {
    throw new Error("saveSwapOutput: outAmount must be a non-negative finite number")
  }
  const freshAddress = output.freshAddress.trim()
  const stored = await chrome.storage.local.get(KEY)
  const current = readStoredList(stored)
  const i = current.findIndex((o) => o.freshAddress === freshAddress)
  if (i >= 0) {
    const prev = current[i]
    current[i] = {
      ...prev,
      ...output,
      freshAddress,
      freshSecretKeyHex:
        typeof output.freshSecretKeyHex === "string" && output.freshSecretKeyHex.trim()
          ? output.freshSecretKeyHex.trim()
          : prev.freshSecretKeyHex,
      createdAt:
        typeof prev.createdAt === "number" && Number.isFinite(prev.createdAt) && prev.createdAt > 0
          ? prev.createdAt
          : output.createdAt,
      reshield: output.reshield !== undefined ? output.reshield : prev.reshield,
      reshieldRecovered:
        output.reshieldRecovered !== undefined ? output.reshieldRecovered : prev.reshieldRecovered
    }
  } else {
    if (typeof output.freshSecretKeyHex !== "string" || !output.freshSecretKeyHex.trim()) {
      throw new Error("saveSwapOutput: freshSecretKeyHex must be a non-empty string")
    }
    current.push({
      ...output,
      freshAddress,
      freshSecretKeyHex: output.freshSecretKeyHex.trim()
    })
  }
  await chrome.storage.local.set({ [KEY]: current })
}

export async function listSwapOutputs(): Promise<SwapOutput[]> {
  const stored = await chrome.storage.local.get(KEY)
  return readStoredList(stored)
}

// Drop a swap row by its fresh address. Used to clear a stale "pending" row the
// reconciler could not positively account for — the funds are already safe (the
// swap either re-shielded into the pool or its input note was never spent), so
// this only removes the misleading Activity entry, never any money.
export async function dismissSwapOutput(freshAddress: string): Promise<void> {
  if (typeof freshAddress !== "string" || !freshAddress.trim()) return
  const target = freshAddress.trim()
  const stored = await chrome.storage.local.get(KEY)
  const current = readStoredList(stored)
  const next = current.filter((o) => o.freshAddress !== target)
  await chrome.storage.local.set({ [KEY]: next })
}
