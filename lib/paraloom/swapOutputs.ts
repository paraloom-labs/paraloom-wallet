// Private swap-out outputs. A private swap leaves the bought token at a FRESH,
// unlinkable address whose key the wallet generated. That key never leaves the
// wallet, so it must be persisted here or the token would be unrecoverable.
//
// Sealed at rest (#1724): the whole store is one secretbox blob under the
// wallet-derived sealing key (`~lib/storage/sealed`), never plaintext. While
// the wallet is locked the blob is opaque — reads return nothing and writes
// refuse — and legacy plaintext rows are sealed on the first unlocked read.
// Once a re-shield has been recovered the fresh address holds nothing, so the
// row's secret key is dropped at that point (see `saveSwapOutput`).
// Stored in extension-local storage (not synced).

import { getSealingKey, isSealedBlob, sealJson, unsealJson } from "~lib/storage/sealed"

export interface SwapOutput {
  /** The fresh, unlinkable address holding the swapped token. */
  freshAddress: string
  /** Secret key (hex) of the fresh address — needed to move the token later.
   *  Empty once the row's re-shield has been recovered (#1724): the bought
   *  token is back in the pool then, so the fresh address holds nothing and
   *  the row keeps no spendable secret at rest. */
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

async function readAll(): Promise<SwapOutput[]> {
  const stored = await chrome.storage.local.get(KEY)
  const raw = stored[KEY]
  if (raw === undefined) return []
  if (isSealedBlob(raw)) {
    const key = await getSealingKey()
    // Locked: the sealed outputs are opaque until the next unlock.
    if (!key) return []
    return unsealJson<SwapOutput[]>(raw, key)
  }
  // Legacy plaintext rows (pre-#1724): seal them on the first unlocked read
  // so no fresh secret key survives in the clear past one unlock. While
  // locked the rows stay put — unreadable either way — until unlock migrates
  // them.
  const legacy = raw as SwapOutput[]
  const key = await getSealingKey()
  if (!key) return []
  await chrome.storage.local.set({ [KEY]: sealJson(legacy, key) })
  return legacy
}

async function writeAll(outputs: SwapOutput[]): Promise<void> {
  const key = await getSealingKey()
  // A write while locked cannot seal, and silently dropping a swap-output
  // write would strand funds — refuse loudly instead. Every caller runs
  // inside an unlocked flow (swap / reconcile / recovery), so this is a bug
  // signal, not a normal path.
  if (!key) throw new Error("wallet is locked: cannot persist swap outputs")
  await chrome.storage.local.set({ [KEY]: sealJson(outputs, key) })
}

// Upsert by freshAddress: the key is saved early (before the withdraw) so it can
// never be lost, then the same entry is updated with the realized amount +
// signature once the swap lands. Keyed on the address so the two writes collapse
// to one row.
export async function saveSwapOutput(output: SwapOutput): Promise<void> {
  const current = await readAll()
  const i = current.findIndex((o) => o.freshAddress === output.freshAddress)
  const merged: SwapOutput = { ...(i >= 0 ? current[i] : {}), ...output }
  // #1724: once the re-shield has been recovered the bought token is back in
  // the pool and the fresh address holds nothing — drop its secret key so a
  // reconciled row keeps no spendable secret at rest. The key was already
  // used by the recovery before this save, and rows that never re-shield keep
  // theirs (the token still sits at the fresh address).
  if (merged.reshieldRecovered) merged.freshSecretKeyHex = ""
  if (i >= 0) current[i] = merged
  else current.push(merged)
  await writeAll(current)
}

export async function listSwapOutputs(): Promise<SwapOutput[]> {
  return readAll()
}

// Drop a swap row by its fresh address. Used to clear a stale "pending" row the
// reconciler could not positively account for — the funds are already safe (the
// swap either re-shielded into the pool or its input note was never spent), so
// this only removes the misleading Activity entry, never any money.
export async function dismissSwapOutput(freshAddress: string): Promise<void> {
  const current = await readAll()
  const next = current.filter((o) => o.freshAddress !== freshAddress)
  await writeAll(next)
}
