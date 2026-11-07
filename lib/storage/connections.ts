// Per-site connection permissions ("trusted apps"), like Phantom's connected
// sites list. An origin is added here only after the user explicitly approves a
// connection request, and removed when they disconnect — so a revoked site is
// prompted again on its next connect().
const CONNECTIONS_KEY = "paraloom_connections"

export function isValidOrigin(origin: string): boolean {
  if (!origin || typeof origin !== "string") return false
  const trimmed = origin.trim()
  if (!trimmed || trimmed === "null" || trimmed.toLowerCase() === "null") return false
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

export async function getApprovedOrigins(): Promise<string[]> {
  const result = await chrome.storage.local.get(CONNECTIONS_KEY)
  const list = result[CONNECTIONS_KEY] as string[] | undefined
  return Array.isArray(list) ? list.filter(isValidOrigin) : []
}

export async function isOriginApproved(origin: string): Promise<boolean> {
  if (!isValidOrigin(origin)) return false
  return (await getApprovedOrigins()).includes(origin.trim())
}

export async function addApprovedOrigin(origin: string): Promise<void> {
  if (!isValidOrigin(origin)) return
  const normalized = origin.trim()
  const list = await getApprovedOrigins()
  if (!list.includes(normalized)) {
    list.push(normalized)
    await chrome.storage.local.set({ [CONNECTIONS_KEY]: list })
  }
}

export async function removeApprovedOrigin(origin: string): Promise<void> {
  const normalized = origin.trim()
  const list = (await getApprovedOrigins()).filter((o) => o !== normalized)
  await chrome.storage.local.set({ [CONNECTIONS_KEY]: list })
}
