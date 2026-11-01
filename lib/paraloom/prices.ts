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
  decimals?: number
}

export async function fetchPrices(
  mints: string[]
): Promise<Record<string, TokenPrice>> {
  const ids = Array.from(new Set([SOL_MINT, ...mints])).filter(Boolean)
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
      { usdPrice?: number; priceChange24h?: number; decimals?: number } | null
    >
    const out: Record<string, TokenPrice> = {}
    for (const [mint, v] of Object.entries(data)) {
      if (v && typeof v.usdPrice === "number") {
        out[mint] = {
          usdPrice: v.usdPrice,
          priceChange24h: typeof v.priceChange24h === "number" ? v.priceChange24h : 0,
          decimals: typeof v.decimals === "number" ? v.decimals : undefined
        }
      }
    }
    return out
  } catch {
    return {}
  }
}
