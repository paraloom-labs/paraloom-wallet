// Per-site connection permissions ("trusted apps"), like Phantom's connected
// sites list. An origin is added here only after the user explicitly approves a
// connection request, and removed when they disconnect — so a revoked site is
// prompted again on its next connect().
const CONNECTIONS_KEY = "paraloom_connections"

export function canonicalizeOrigin(origin: string): string | null {
  if (typeof origin !== "string" || !origin.trim() || origin === "null") {
    return null
  }
  try {
    const url = new URL(origin)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null
    }
    if (!url.origin || url.origin === "null") {
      return null
    }
    return url.origin
  } catch {
    return null
  }
}

export async function getApprovedOrigins(): Promise<string[]> {
  const result = await chrome.storage.local.get(CONNECTIONS_KEY)
  const list = result[CONNECTIONS_KEY] as string[] | undefined
  if (!Array.isArray(list)) return []
  const canonicalSet = new Set<string>()
  for (const item of list) {
    const c = canonicalizeOrigin(item)
    if (c) canonicalSet.add(c)
  }
  return Array.from(canonicalSet)
}

export async function isOriginApproved(origin: string): Promise<boolean> {
  const canonical = canonicalizeOrigin(origin)
  if (!canonical) return false
  const list = await getApprovedOrigins()
  return list.includes(canonical)
}

export async function addApprovedOrigin(origin: string): Promise<void> {
  const canonical = canonicalizeOrigin(origin)
  if (!canonical) {
    throw new Error(`Invalid or disallowed origin: ${origin}`)
  }
  const list = await getApprovedOrigins()
  if (!list.includes(canonical)) {
    list.push(canonical)
    await chrome.storage.local.set({ [CONNECTIONS_KEY]: list })
  }
}

export async function removeApprovedOrigin(origin: string): Promise<void> {
  const canonical = canonicalizeOrigin(origin)
  if (!canonical) return
  const list = (await getApprovedOrigins()).filter((o) => o !== canonical)
  await chrome.storage.local.set({ [CONNECTIONS_KEY]: list })
}
