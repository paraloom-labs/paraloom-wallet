// Per-site connection permissions ("trusted apps"), like Phantom's connected
// sites list. An origin is added here only after the user explicitly approves a
// connection request, and removed when they disconnect — so a revoked site is
// prompted again on its next connect().
const CONNECTIONS_KEY = "paraloom_connections"

export function canonicalizeOrigin(origin: string): string | null {
  if (!origin || typeof origin !== "string" || origin === "null") return null
  try {
    const u = new URL(origin)
    if (u.protocol !== "http:" && u.protocol !== "https:") return null
    if (u.origin === "null") return null
    return u.origin
  } catch {
    return null
  }
}

export async function getApprovedOrigins(): Promise<string[]> {
  const result = await chrome.storage.local.get(CONNECTIONS_KEY)
  const list = result[CONNECTIONS_KEY] as string[] | undefined
  return Array.isArray(list) ? list : []
}

export async function isOriginApproved(origin: string): Promise<boolean> {
  const canon = canonicalizeOrigin(origin)
  if (!canon) return false
  return (await getApprovedOrigins()).includes(canon)
}

export async function addApprovedOrigin(origin: string): Promise<void> {
  const canon = canonicalizeOrigin(origin)
  if (!canon) return
  const list = await getApprovedOrigins()
  if (!list.includes(canon)) {
    list.push(canon)
    await chrome.storage.local.set({ [CONNECTIONS_KEY]: list })
  }
}

export async function removeApprovedOrigin(origin: string): Promise<void> {
  const canon = canonicalizeOrigin(origin) ?? origin
  const list = (await getApprovedOrigins()).filter((o) => o !== canon && o !== origin)
  await chrome.storage.local.set({ [CONNECTIONS_KEY]: list })
}
