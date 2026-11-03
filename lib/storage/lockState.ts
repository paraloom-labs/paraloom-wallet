// The durable `locked` flag in chrome.storage.local and the decrypted
// WalletSession in chrome.storage.session are two different lifetimes. Chrome
// wipes session storage on browser exit, but the local flag survives, so a
// wallet that was unlocked when the browser closed comes back with
// `locked: false` and no session. Treating that stale flag as "unlocked" makes
// dApp connects return success without ever opening the unlock popup.
//
// This helper is the single source of truth for lock decisions: a wallet is
// only effectively unlocked when the disk flag is false AND a live session
// exists. When it finds the impossible stale combination it repairs the flag.
import { isWalletLocked, setLockState } from "./secure"
import { loadSession } from "./session"

/**
 * Return the effective lock state and repair a stale `locked: false` flag.
 *
 * - `locked: true` → locked, no session read needed.
 * - `locked: false` + live session → unlocked.
 * - `locked: false` + no session (browser restarted) → repair to locked and
 *   return true.
 */
export async function reconcileEffectiveLockState(): Promise<boolean> {
  if (await isWalletLocked()) return true
  try {
    if (await loadSession()) return false
  } catch {
    // A corrupted/partially-written session cannot unlock the wallet; fall
    // through to the same repair as a missing one rather than leaving the flag
    // unlocked and the popup broken.
  }
  await setLockState(true)
  return true
}
