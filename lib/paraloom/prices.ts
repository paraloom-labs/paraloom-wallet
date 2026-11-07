// USD prices for the Home portfolio, from Jupiter's price API. Keyed by base58
// mint so it scales to any future shielded SPL — pass the mints you hold and get
// back { usdPrice, priceChange24h } per mint. Best-effort: a failed fetch just
// yields no prices (the UI then shows amounts without a USD value).

const JUP_PRICE_URL = "https://lite-api.jup.ag/price/v3"

// Wrapped-SOL mint — the price id for native SOL.
export const SOL_MINT = "So11111111111111111111111111111111111111112"

export const MAX_PRICE_IDS = 100
export const MAX_USD_PRICE = 1e12
export const MIN_PRICE_CHANGE_24H = -100
export const MAX_PRICE_CHANGE_24H = 1e6

export interface TokenPrice {
  usdPrice: number
  priceChange24h: number // percent, e.g. -0.19
}

export async function fetchPrices(mints: string[]): Promise<Record<string, TokenPrice>> {
  const ids = Array.from(new Set([SOL_MINT, ...mints]))
    .filter(Boolean)
    .slice(0, MAX_PRICE_IDS)
  if (ids.length === 0) return {}
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(`${JUP_PRICE_URL}?ids=${ids.join(",")}`, {
      signal: ctrl.signal
    })
    clearTimeout(t)
    if (!res.ok) return {}
    const data = (await res.json()) as Record<
      string,
      { usdPrice?: number; priceChange24h?: number } | null
    >
    const out: Record<string, TokenPrice> = {}
    for (const [mint, v] of Object.entries(data)) {
      if (
        v &&
        typeof v.usdPrice === "number" &&
        Number.isFinite(v.usdPrice) &&
        v.usdPrice >= 0 &&
        v.usdPrice <= MAX_USD_PRICE
      ) {
        const change =
          typeof v.priceChange24h === "number" &&
          Number.isFinite(v.priceChange24h) &&
          v.priceChange24h >= MIN_PRICE_CHANGE_24H &&
          v.priceChange24h <= MAX_PRICE_CHANGE_24H
            ? v.priceChange24h
            : 0
        out[mint] = {
          usdPrice: v.usdPrice,
          priceChange24h: change
        }
      }
    }
    return out
  } catch {
    return {}
  }
}
