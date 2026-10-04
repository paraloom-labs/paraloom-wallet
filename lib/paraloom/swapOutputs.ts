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
  /** Whether the user dismissed this row from the Activity view (#854). The key
   *  remains preserved in storage so stranded funds can still be recovered. */
  dismissed?: boolean
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

export async function listSwapOutputs(includeDismissed = false): Promise<SwapOutput[]> {
  const stored = await chrome.storage.local.get(KEY)
  const all = (stored[KEY] as SwapOutput[]) ?? []
  return includeDismissed ? all : all.filter((o) => !o.dismissed)
}

// Hide a swap row from the Activity feed by marking it dismissed (#854).
// Used to clear a stale "pending" row from the UI while PRESERVING the
// freshSecretKeyHex in storage so any funds still sitting at the fresh address
// (e.g. from an interrupted swap leg) remain recoverable.
export async function dismissSwapOutput(freshAddress: string): Promise<void> {
  const stored = await chrome.storage.local.get(KEY)
  const current = (stored[KEY] as SwapOutput[]) ?? []
  const next = current.map((o) =>
    o.freshAddress === freshAddress ? { ...o, dismissed: true } : o
  )
  await chrome.storage.local.set({ [KEY]: next })
}
