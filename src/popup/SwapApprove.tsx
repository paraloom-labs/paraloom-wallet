import logoImg from "data-base64:~/../assets/icon.png"
import React, { useState } from "react"

interface SwapParams {
  outputMint: string
  inputMint?: string
  amountLamports: string
  slippageBps?: number
  reshield?: boolean
}

interface SwapApproveProps {
  id: number
  origin: string
  params: SwapParams
  onResolved: () => void
}

type Status = "idle" | "approved" | "rejected"

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

function sendMessage(message: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve))
}

export function tokenLabel(mint?: string): string {
  if (!mint || typeof mint !== "string") return "Unknown"
  if (mint === "SOL") return "SOL"
  if (mint === USDC_MINT) return "USDC"
  return mint.length >= 8 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint
}

// Decimals + symbol for the input side. Only native SOL and USDC are spendable
// inputs today; an unknown mint falls back to showing raw base units.
export function inputInfo(inputMint?: string): { decimals: number; symbol: string } {
  if (!inputMint || typeof inputMint !== "string" || inputMint === "SOL")
    return { decimals: 9, symbol: "SOL" }
  if (inputMint === USDC_MINT) return { decimals: 6, symbol: "USDC" }
  return { decimals: 0, symbol: tokenLabel(inputMint) }
}

export function formatAmount(amount?: string, decimals: number = 0): string {
  try {
    if (!amount || typeof amount !== "string") return "0"
    const raw = BigInt(amount)
    if (raw === 0n) return "0"
    const n = decimals === 0 ? Number(raw) : Number(raw) / 10 ** decimals
    return n.toLocaleString(undefined, { maximumFractionDigits: 6 })
  } catch {
    return amount || "0"
  }
}

export function SwapApprove({ id, origin, params, onResolved }: SwapApproveProps) {
  const [status, setStatus] = useState<Status>("idle")

  const safeParams = params || {
    outputMint: "SOL",
    amountLamports: "0"
  }

  let host = origin
  try {
    host = new URL(origin).host
  } catch {}

  async function decide(approved: boolean) {
    if (status !== "idle") return
    setStatus(approved ? "approved" : "rejected")
    await sendMessage({ type: approved ? "APPROVE_SWAP" : "REJECT_SWAP", id })
    // The swap runs in the background after approval; the window just closes.
    setTimeout(
      () => {
        window.close()
        setTimeout(onResolved, 400)
      },
      approved ? 900 : 350
    )
  }

  if (status !== "idle") {
    const approved = status === "approved"
    return (
      <div className="connect-approve">
        <div className="connect-result">
          <div className={`connect-badge ${approved ? "ok" : "no"}`}>
            {approved ? (
              <svg
                width="34"
                height="34"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg
                width="34"
                height="34"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            )}
          </div>
          <h2 className="connect-title">{approved ? "Swapping…" : "Rejected"}</h2>
          <div className="connect-origin">{host}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="connect-approve">
      <img src={logoImg} alt="paraloom" className="connect-logo" />
      <h2 className="connect-title">Approve private swap</h2>
      <div className="connect-origin">{host}</div>
      <p className="connect-desc">
        This spends{" "}
        <strong>
          {formatAmount(safeParams.amountLamports, inputInfo(safeParams.inputMint).decimals)}{" "}
          {inputInfo(safeParams.inputMint).symbol}
        </strong>{" "}
        from your shielded balance, exits to a fresh unlinkable address, and swaps to{" "}
        <strong>{tokenLabel(safeParams.outputMint)}</strong> there.{" "}
        {safeParams.reshield
          ? "The result is re-shielded back into your Paraloom balance."
          : "The result stays at that address (it is not re-shielded)."}{" "}
        Only approve swaps you started.
      </p>
      <div className="connect-actions">
        <button className="button button-secondary" onClick={() => decide(false)}>
          Reject
        </button>
        <button className="button" onClick={() => decide(true)}>
          Approve
        </button>
      </div>
    </div>
  )
}
