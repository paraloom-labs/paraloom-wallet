import { addApprovedOrigin } from "~lib/storage/connections"

export const PENDING_CONN_KEY = "pendingConn"
export const DEFAULT_CONNECTION_TIMEOUT_MS = 120_000

export interface PersistedPendingConnection {
  id: number
  origin: string
  expiresAt: number
}

export function isPendingConnectionExpired(
  pc: { expiresAt?: number },
  now: number = Date.now()
): boolean {
  return typeof pc.expiresAt === "number" && now >= pc.expiresAt
}

export async function getPendingConnection(
  now: number = Date.now()
): Promise<{ id: number; origin: string } | null> {
  const result = await chrome.storage.session.get(PENDING_CONN_KEY)
  const pc = result[PENDING_CONN_KEY] as PersistedPendingConnection | undefined
  if (!pc || typeof pc.id !== "number" || typeof pc.origin !== "string") {
    return null
  }
  if (isPendingConnectionExpired(pc, now)) {
    await clearPendingConnection()
    return null
  }
  return { id: pc.id, origin: pc.origin }
}

export async function recordPendingConnection(
  id: number,
  origin: string,
  timeoutMs: number = DEFAULT_CONNECTION_TIMEOUT_MS,
  now: number = Date.now()
): Promise<void> {
  const item: PersistedPendingConnection = {
    id,
    origin,
    expiresAt: now + timeoutMs
  }
  await chrome.storage.session.set({ [PENDING_CONN_KEY]: item })
}

export async function clearPendingConnection(): Promise<void> {
  await chrome.storage.session.remove(PENDING_CONN_KEY)
}

export interface ApproveResult {
  success: boolean
  origin?: string
  error?: string
}

export async function approvePendingConnection(
  id: number,
  now: number = Date.now()
): Promise<ApproveResult> {
  const result = await chrome.storage.session.get(PENDING_CONN_KEY)
  const pc = result[PENDING_CONN_KEY] as PersistedPendingConnection | undefined

  if (!pc || typeof pc.id !== "number" || typeof pc.origin !== "string") {
    return { success: false, error: "no pending connection" }
  }

  if (isPendingConnectionExpired(pc, now)) {
    await clearPendingConnection()
    return { success: false, error: "connection request expired" }
  }

  if (pc.id !== id) {
    return { success: false, error: "invalid connection id" }
  }

  await addApprovedOrigin(pc.origin)
  await clearPendingConnection()
  return { success: true, origin: pc.origin }
}

export async function rejectPendingConnection(id: number): Promise<void> {
  const result = await chrome.storage.session.get(PENDING_CONN_KEY)
  const pc = result[PENDING_CONN_KEY] as PersistedPendingConnection | undefined
  if (pc && pc.id === id) {
    await clearPendingConnection()
  } else if (!pc) {
    await clearPendingConnection()
  }
}

export async function cleanStalePendingConnection(now: number = Date.now()): Promise<boolean> {
  const result = await chrome.storage.session.get(PENDING_CONN_KEY)
  const pc = result[PENDING_CONN_KEY] as PersistedPendingConnection | undefined
  if (pc && isPendingConnectionExpired(pc, now)) {
    await clearPendingConnection()
    return true
  }
  return false
}
