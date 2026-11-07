// USD prices for the Home portfolio, from Jupiter's price API. Keyed by base58
// mint so it scales to any future shielded SPL — pass the mints you hold and get
// back { usdPrice, priceChange24h } per mint. Best-effort: a failed fetch just
// yields no prices (the UI then shows amounts without a USD value).

const JUP_PRICE_URL = "https://lite-api.jup.ag/price/v3"

// Wrapped-SOL mint — the price id for native SOL.
export const SOL_MINT = "So11111111111111111111111111111111111111112"

export interface TokenPrice {
  usdPrice: number
  priceChange24h: number // percent, e.g. -0.19
}

export async function fetchPrices(
  mints: string[]
): Promise<Record<string, TokenPrice>> {
  const normalizedMints = (Array.isArray(mints) ? mints : []).map(m => m === "SOL" ? SOL_MINT : m)
  const ids = Array.from(new Set([SOL_MINT, ...normalizedMints]))
    .filter(id => typeof id === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(id))
  if (ids.length === 0) return {}

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 8000)
  try {
    const encodedIds = ids.map(encodeURIComponent).join(",")
    const res = await fetch(`${JUP_PRICE_URL}?ids=${encodedIds}`, {
      signal: ctrl.signal
    })
    if (!res.ok) return {}
    const data = (await res.json()) as Record<
      string,
      { usdPrice?: number; priceChange24h?: number } | null
    >
    if (!data || typeof data !== "object") return {}

    const out: Record<string, TokenPrice> = {}
    for (const [mint, v] of Object.entries(data)) {
      if (
        v &&
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
    return out
  } catch {
    return {}
  } finally {
    clearTimeout(t)
  }
}
