// Per-site connection permissions ("trusted apps"), like Phantom's connected
// sites list. An origin is added here only after the user explicitly approves a
// connection request, and removed when they disconnect — so a revoked site is
// prompted again on its next connect().
import { isWalletLocked, setLockState } from "./secure"
import { loadSession } from "./session"

const CONNECTIONS_KEY = "paraloom_connections"

export async function getApprovedOrigins(): Promise<string[]> {
  const result = await chrome.storage.local.get(CONNECTIONS_KEY)
  const list = result[CONNECTIONS_KEY] as string[] | undefined
  return Array.isArray(list) ? list : []
}

export async function isOriginApproved(origin: string): Promise<boolean> {
  return (await getApprovedOrigins()).includes(origin)
}

export async function addApprovedOrigin(origin: string): Promise<void> {
  const list = await getApprovedOrigins()
  if (!list.includes(origin)) {
    list.push(origin)
    await chrome.storage.local.set({ [CONNECTIONS_KEY]: list })
  }
}

export async function removeApprovedOrigin(origin: string): Promise<void> {
  const list = (await getApprovedOrigins()).filter((o) => o !== origin)
  await chrome.storage.local.set({ [CONNECTIONS_KEY]: list })
}

/**
 * Authorize a page sender strictly against durable origin approvals in
 * `chrome.storage.local`. Relying on an in-memory `connectedOrigin === origin`
 * short-circuit allowed a site disconnected in Settings (`handleRevokeSite`)
 * to retain full dApp read/swap privileges for the lifetime of the background
 * worker.
 */
export async function isSenderAuthorizedForOrigin(
  origin: string | null
): Promise<boolean> {
  if (!origin) return false
  return isOriginApproved(origin)
}

export interface PendingOriginRequest {
  id: number
  origin: string
  resolve: (approved: boolean) => void
}

/**
 * Revoke `origin` from durable storage, clear `connectedOrigin` when it
 * matches, and reject any outstanding connection or swap approval request
 * initiated by that origin.
 */
export async function revokeOriginAuthorization(
  origin: string,
  state: {
    connectedOrigin: string | null
    pendingConnection?: PendingOriginRequest | null
    pendingSwap?: PendingOriginRequest | null
  }
): Promise<{ connectedOrigin: string | null }> {
  await removeApprovedOrigin(origin)
  const nextConnectedOrigin =
    state.connectedOrigin === origin ? null : state.connectedOrigin
  if (state.pendingConnection && state.pendingConnection.origin === origin) {
    state.pendingConnection.resolve(false)
  }
  if (state.pendingSwap && state.pendingSwap.origin === origin) {
    state.pendingSwap.resolve(false)
  }
  return { connectedOrigin: nextConnectedOrigin }
}

/**
 * Determine whether the wallet is effectively locked by requiring BOTH the
 * persistent `locked: false` flag in `chrome.storage.local` AND a live
 * decrypted session in memory-only `chrome.storage.session`. When the browser
 * restarts after an unlocked session, `chrome.storage.local` still has
 * `locked: false` while `chrome.storage.session` is empty; reconcile the stale
 * disk flag back to `true` so `handleConnect`, `waitForUnlock`, and
 * `maybeAutoLock` never treat a sessionless wallet as unlocked.
 */
export async function reconcileEffectiveLockState(): Promise<boolean> {
  const locked = await isWalletLocked()
  const session = await loadSession()
  if (!session) {
    if (!locked) {
      await setLockState(true)
    }
    return true
  }
  return locked
}
