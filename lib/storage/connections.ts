// Per-site connection permissions ("trusted apps"), like Phantom's connected
// sites list. An origin is added here only after the user explicitly approves a
// connection request, and removed when they disconnect — so a revoked site is
// prompted again on its next connect().
const CONNECTIONS_KEY = "paraloom_connections"
const PENDING_CONN_KEY = "pendingConn"

export interface PendingConnectionRecord {
  id: number
  origin: string
}

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
 * Revoke a caller origin's connection permission even if the MV3 service worker
 * restarted (clearing in-memory `connectedOrigin`), auto-locked, or another
 * approved site connected in the meantime. Only the caller's own `origin` is
 * ever removed, preserving cross-origin isolation (#711/#719).
 */
export async function disconnectOrigin(
  origin: string | null,
  currentConnectedOrigin: string | null
): Promise<{ nextConnectedOrigin: string | null; revoked: boolean }> {
  if (!origin) {
    return { nextConnectedOrigin: currentConnectedOrigin, revoked: false }
  }
  const matchesActive = currentConnectedOrigin === origin
  const nextConnectedOrigin = matchesActive ? null : currentConnectedOrigin
  const approved = await isOriginApproved(origin)
  if (matchesActive || approved) {
    await removeApprovedOrigin(origin)
    return { nextConnectedOrigin, revoked: true }
  }
  return { nextConnectedOrigin, revoked: false }
}

export async function getPendingConnection(): Promise<PendingConnectionRecord | null> {
  try {
    const r = await chrome.storage.session.get(PENDING_CONN_KEY)
    const pc = r[PENDING_CONN_KEY] as PendingConnectionRecord | undefined
    return pc && typeof pc.id === "number" && typeof pc.origin === "string"
      ? pc
      : null
  } catch {
    return null
  }
}

export async function isOriginConnectionPending(
  origin: string | null
): Promise<boolean> {
  if (!origin) return false
  const pc = await getPendingConnection()
  return pc?.origin === origin
}

export type RelayFn = (
  type: string,
  payload?: Record<string, unknown>
) => Promise<any>

/**
 * Execute the dApp `connect()` handshake via `relay`:
 * - Propagates explicit `CONNECT_WALLET` rejections (`"Connection request rejected"`,
 *   `"No wallet found"`, unlock timeout) immediately instead of polling for 126s.
 * - Survives MV3 worker eviction mid-approval by polling `IS_CONNECTED` while
 *   `pending` is true, and aborts immediately if `pendingConn` was cleared by
 *   `REJECT_CONNECTION` without approving the origin.
 * - Requires `!locked` before resolving via the polling path so a locked wallet
 *   on a previously approved origin waits for the user to unlock first.
 */
export async function connectWithRelay(
  relay: RelayFn,
  pollIntervalMs = 700,
  maxPolls = 180
): Promise<{ address: string; publicKey: string }> {
  let connectError: string | null = null
  let connectData: { address: string; publicKey: string } | null = null
  let connectChannelClosed = false
  let sawPending = false

  void relay("CONNECT_WALLET")
    .then((res) => {
      if (res?.success && res?.data?.address) {
        connectData = {
          address: res.data.address,
          publicKey: res.data.publicKey ?? res.data.address
        }
      } else if (res && res.success === false) {
        connectError = res.error || "Connection request rejected"
      }
    })
    .catch(() => {
      // MV3 worker eviction mid-wait closes the message port; fall back to
      // polling IS_CONNECTED + pending state below.
      connectChannelClosed = true
    })

  for (let i = 0; i < maxPolls; i++) {
    if (connectData) return connectData
    if (connectError) throw new Error(connectError)

    const c = await relay("IS_CONNECTED").catch(() => null)
    if (c?.connected && !c?.locked) {
      const a = await relay("GET_ADDRESS").catch(() => null)
      if (a?.address) return { address: a.address, publicKey: a.address }
    }

    if (c?.pending) {
      sawPending = true
    } else if (
      (sawPending || connectChannelClosed) &&
      !c?.connected &&
      i > 0
    ) {
      if (connectError) throw new Error(connectError)
      throw new Error("Connection request rejected")
    }

    await new Promise((res) => setTimeout(res, pollIntervalMs))
  }

  if (connectError) throw new Error(connectError)
  throw new Error("Connection request timed out")
}

