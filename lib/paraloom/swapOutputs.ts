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
  /** The shielded account that ran the swap. Required for recovery to be
   *  correct: the reconciler walks every row, but a row may only be finished or
   *  recorded into the account whose spend key its notes bind. Without it a
   *  stranded swap was credited to whichever account happened to be active. */
  shieldedAddress: string
  /** The cluster the swap settles on. Private swaps are mainnet-only, but the
   *  row already has to carry it so the reconciler's `Connection` and the row
   *  can never disagree. */
  network?: "mainnet-beta" | "devnet"
  /** Whether the user asked to re-shield the bought token (a round trip). Saved
   *  so a resumed/recovered swap honors the original intent. */
  reshield?: boolean
  /** Set once the re-shield note has been persisted (either normally or via the
   *  recovery scan), so recovery does not re-scan a settled reshield each connect. */
  reshieldRecovered?: boolean
  createdAt: number
}

const KEY = "paraloom_swap_outputs"

// Upsert by freshAddress: the key is saved early (before the withdraw) so it can
// never be lost, then the same entry is updated with the realized amount +
// signature once the swap lands. Keyed on the address so the two writes collapse
// to one row.
//
// The existing owner wins over an incoming blank one: later writers (the landed
// upsert, the reconciler, recovery) re-send a row they merely read, and a writer
// that did not carry `shieldedAddress` must not strip the account off it.
export async function saveSwapOutput(output: SwapOutput): Promise<void> {
  const stored = await chrome.storage.local.get(KEY)
  const current = (stored[KEY] as SwapOutput[]) ?? []
  const i = current.findIndex((o) => o.freshAddress === output.freshAddress)
  if (i >= 0) {
    const merged = { ...current[i], ...output }
    if (!output.shieldedAddress) merged.shieldedAddress = current[i].shieldedAddress
    if (!output.network) merged.network = current[i].network ?? "mainnet-beta"
    current[i] = merged
  } else {
    // Private swaps are mainnet-only, so a row created without an explicit
    // cluster belongs there. Rows written before the field existed inherit the
    // same default on their next write rather than staying untyped.
    current.push({ network: "mainnet-beta", ...output })
  }
  await chrome.storage.local.set({ [KEY]: current })
}

export async function listSwapOutputs(): Promise<SwapOutput[]> {
  const stored = await chrome.storage.local.get(KEY)
  return (stored[KEY] as SwapOutput[]) ?? []
}

// Rows that belong to `shieldedAddress`. Recovery must never act on another
// account's row: it files the recovered note under the account it was given, so
// a foreign row would land in a wallet that does not hold its spend key.
export async function listSwapOutputsFor(shieldedAddress: string): Promise<SwapOutput[]> {
  const all = await listSwapOutputs()
  return all.filter((o) => {
    // Rows written before this field existed can only belong to the account
    // that is active now (there was no other way to have created them), so
    // adopt them there instead of orphaning the funds behind them.
    if (o.shieldedAddress) return o.shieldedAddress === shieldedAddress
    return true
  })
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
