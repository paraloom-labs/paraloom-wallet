// USD prices for the Home portfolio, from Jupiter's price API. Keyed by base58
// mint so it scales to any future shielded SPL — pass the mints you hold and get
// back { usdPrice, priceChange24h } per mint. Best-effort: a failed fetch just
// yields no prices (the UI then shows amounts without a USD value).

const JUP_PRICE_URL = "https://lite-api.jup.ag/price/v3"

// Wrapped-SOL mint — the price id for native SOL.
export const SOL_MINT = "So11111111111111111111111111111111111111112"

const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export interface TokenPrice {
  usdPrice: number
  priceChange24h: number // percent, e.g. -0.19
}

export async function fetchPrices(
  mints: string[]
): Promise<Record<string, TokenPrice>> {
  const normalizedMints = (Array.isArray(mints) ? mints : []).map((m) =>
    m === "SOL" ? SOL_MINT : m
  )
  const candidateIds = Array.from(new Set([SOL_MINT, ...normalizedMints]))
  const validIds = candidateIds.filter((id) => typeof id === "string" && BASE58_REGEX.test(id))
  if (validIds.length === 0) return {}

  const queryIds = validIds.map((id) => encodeURIComponent(id)).join(",")
  let t: ReturnType<typeof setTimeout> | undefined
  try {
    const ctrl = new AbortController()
    t = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(`${JUP_PRICE_URL}?ids=${queryIds}`, {
      signal: ctrl.signal
    })
    if (!res.ok) return {}
    const json: unknown = await res.json()
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      return {}
    }
    const data = json as Record<
      string,
      { usdPrice?: unknown; priceChange24h?: unknown } | null
    >
    const out: Record<string, TokenPrice> = {}
    for (const [mint, v] of Object.entries(data)) {
      if (
        v &&
        typeof v === "object" &&
        typeof v.usdPrice === "number" &&
        Number.isFinite(v.usdPrice) &&
        v.usdPrice >= 0
      ) {
        out[mint] = {
          usdPrice: v.usdPrice,
          priceChange24h:
            typeof v.priceChange24h === "number" && Number.isFinite(v.priceChange24h)
              ? v.priceChange24h
              : 0
        }
      }
    }
    if (out[SOL_MINT] && !out["SOL"]) {
      out["SOL"] = out[SOL_MINT]
    }
    return out
  } catch {
    return {}
  } finally {
    if (t !== undefined) {
      clearTimeout(t)
    }
  }
}
