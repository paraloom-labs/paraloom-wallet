// Per-site connection permissions ("trusted apps"), like Phantom's connected
// sites list. An origin is added here only after the user explicitly approves a
// connection request, and removed when they disconnect — so a revoked site is
// prompted again on its next connect().
const CONNECTIONS_KEY = "paraloom_connections"

export function normalizeOrigin(origin: string): string | null {
  if (typeof origin !== "string" || !origin || origin === "null") return null
  try {
    const u = new URL(origin)
    if (u.protocol !== "https:" && u.protocol !== "http:") return null
    if (!u.origin || u.origin === "null") return null
    return u.origin
  } catch {
    return null
  }
}

export async function getApprovedOrigins(): Promise<string[]> {
  const result = await chrome.storage.local.get(CONNECTIONS_KEY)
  const list = result[CONNECTIONS_KEY] as string[] | undefined
  if (!Array.isArray(list)) return []
  return Array.from(
    new Set(list.map((o) => normalizeOrigin(o)).filter((o): o is string => o !== null))
  )
}

export async function isOriginApproved(origin: string): Promise<boolean> {
  const norm = normalizeOrigin(origin)
  if (!norm) return false
  return (await getApprovedOrigins()).includes(norm)
}

export async function addApprovedOrigin(origin: string): Promise<void> {
  const norm = normalizeOrigin(origin)
  if (!norm) return
  const list = await getApprovedOrigins()
  if (!list.includes(norm)) {
    list.push(norm)
    await chrome.storage.local.set({ [CONNECTIONS_KEY]: list })
  }
}

export async function removeApprovedOrigin(origin: string): Promise<void> {
  const norm = normalizeOrigin(origin)
  const list = (await getApprovedOrigins()).filter((o) => o !== norm && o !== origin)
  await chrome.storage.local.set({ [CONNECTIONS_KEY]: list })
}
