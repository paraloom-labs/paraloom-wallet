// Per-site connection permissions ("trusted apps"), like Phantom's connected
// sites list. An origin is added here only after the user explicitly approves a
// connection request, and removed when they disconnect — so a revoked site is
// prompted again on its next connect().
const CONNECTIONS_KEY = "paraloom_connections"
const CONNECTIONS_WRITE_LOCK = `${CONNECTIONS_KEY}:write`

let fallbackLockQueue: Promise<unknown> = Promise.resolve()

async function withConnectionsWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    return navigator.locks.request(CONNECTIONS_WRITE_LOCK, fn)
  }
  const next = fallbackLockQueue.then(fn, fn)
  fallbackLockQueue = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

export async function getApprovedOrigins(): Promise<string[]> {
  const result = await chrome.storage.local.get(CONNECTIONS_KEY)
  const list = result[CONNECTIONS_KEY] as string[] | undefined
  return Array.isArray(list) ? list : []
}

export async function isOriginApproved(origin: string): Promise<boolean> {
  return (await getApprovedOrigins()).includes(origin)
}

// Popup and background contexts share chrome.storage, but not module state.
// Serialize the entire read/modify/write across those contexts: otherwise a
// delayed approval can restore an origin that another completed write revoked.
async function updateApprovedOrigins(
  update: (list: string[]) => string[] | null
): Promise<void> {
  await withConnectionsWriteLock(async () => {
    const next = update(await getApprovedOrigins())
    if (next !== null) {
      await chrome.storage.local.set({ [CONNECTIONS_KEY]: next })
    }
  })
}

export async function addApprovedOrigin(origin: string): Promise<void> {
  await updateApprovedOrigins((list) =>
    list.includes(origin) ? null : [...list, origin]
  )
}

export async function removeApprovedOrigin(origin: string): Promise<void> {
  await updateApprovedOrigins((list) => list.filter((o) => o !== origin))
}
