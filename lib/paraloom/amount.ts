export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
export const WSOL_MINT = "So11111111111111111111111111111111111111112"

export function tokenLabel(mint: string): string {
  if (mint === "SOL" || mint === WSOL_MINT) return "SOL"
  if (mint === USDC_MINT) return "USDC"
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`
}

// Decimals + symbol for the input side. Only native SOL and USDC are spendable
// inputs today; an unknown mint falls back to showing raw base units.
export function inputInfo(inputMint?: string): { decimals: number; symbol: string } {
  if (!inputMint || inputMint === "SOL" || inputMint === WSOL_MINT) return { decimals: 9, symbol: "SOL" }
  if (inputMint === USDC_MINT) return { decimals: 6, symbol: "USDC" }
  return { decimals: 0, symbol: tokenLabel(inputMint) }
}

export function formatAmount(amount: string, decimals: number): string {
  try {
    if (typeof amount !== "string" || !/^\d+$/.test(amount.trim())) {
      return amount
    }
    const clean = amount.trim()
    const bi = BigInt(clean)
    if (decimals <= 0) {
      return bi.toLocaleString()
    }
    const divisor = 10n ** BigInt(decimals)
    const integerPart = (bi / divisor).toLocaleString()
    const remainder = bi % divisor
    if (remainder === 0n) {
      return integerPart
    }
    let fraction = remainder.toString().padStart(decimals, "0")
    fraction = fraction.replace(/0+$/, "")
    return `${integerPart}.${fraction}`
  } catch {
    return amount
  }
}
