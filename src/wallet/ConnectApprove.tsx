import { useState } from "react"
import logoImg from "data-base64:~/../assets/icon.png"

interface ConnectApproveProps {
  id: number
  origin: string
  onResolved: () => void
}

type Status = "idle" | "connected" | "rejected"

function sendMessage(message: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve))
}

export function ConnectApprove({ id, origin, onResolved }: ConnectApproveProps) {
  const [status, setStatus] = useState<Status>("idle")

  let host = origin
  try {
    host = new URL(origin).host
  } catch {}

  async function decide(approved: boolean) {
    if (status !== "idle") return
    setStatus(approved ? "connected" : "rejected")

    await sendMessage({
      type: approved ? "APPROVE_CONNECTION" : "REJECT_CONNECTION",
      id
    })

    // Hold the confirmation screen briefly so the transition reads as
    // intentional, then close the request window. We deliberately do NOT flip
    // the popup back to Home (that caused a jarring balance flash) — the window
    // just closes. onResolved is only a fallback for when close() is blocked.
    setTimeout(() => {
      window.close()
      setTimeout(onResolved, 400)
    }, approved ? 900 : 350)
  }

  if (status !== "idle") {
    const approved = status === "connected"
    return (
      <div className="connect-approve">
        <div className="connect-result">
          <div className={`connect-badge ${approved ? "ok" : "no"}`}>
            {approved ? (
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            )}
          </div>
          <h2 className="connect-title">{approved ? "Connected" : "Rejected"}</h2>
          <div className="connect-origin">{host}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="connect-approve">
      <img src={logoImg} alt="paraloom" className="connect-logo" />
      <h2 className="connect-title">Connect wallet</h2>
      <div className="connect-origin">{host}</div>
      <p className="connect-desc">
        This site wants to connect to your Paraloom wallet and will be able to
        see your shielded address. Only connect to sites you trust.
      </p>
      <div className="connect-actions">
        <button
          className="button button-secondary"
          onClick={() => decide(false)}>
          Reject
        </button>
        <button className="button" onClick={() => decide(true)}>
          Connect
        </button>
      </div>
    </div>
  )
}
