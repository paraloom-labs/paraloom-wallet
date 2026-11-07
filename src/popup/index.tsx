import { getStoredWallet, isWalletLocked, setLockState } from "~lib/storage/secure"
import { loadSession } from "~lib/storage/session"
import { useWalletStore } from "~lib/store/walletStore"
import { ConnectApprove } from "~src/popup/ConnectApprove"
import { Home } from "~src/popup/Home"
import { Onboarding } from "~src/popup/Onboarding"
import { SwapApprove } from "~src/popup/SwapApprove"
import { Unlock } from "~src/popup/Unlock"
import React, { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import "./style.css"

export interface PendingSwap {
  id: number
  origin: string
  params: {
    outputMint: string
    inputMint?: string
    amountLamports: string
    slippageBps?: number
    reshield?: boolean
  }
}

export function isValidPendingSwap(raw: unknown): raw is PendingSwap {
  if (!raw || typeof raw !== "object") return false
  const r = raw as Partial<PendingSwap>
  if (typeof r.id !== "number" || typeof r.origin !== "string" || !r.origin.trim()) return false
  if (!r.params || typeof r.params !== "object") return false
  const p = r.params as Partial<PendingSwap["params"]>
  if (typeof p.outputMint !== "string" || !p.outputMint.trim()) return false
  if (typeof p.amountLamports !== "string" || !p.amountLamports.trim()) return false
  try {
    const amt = BigInt(p.amountLamports)
    if (amt <= 0n) return false
  } catch {
    return false
  }
  if (p.inputMint !== undefined && (typeof p.inputMint !== "string" || !p.inputMint.trim())) {
    return false
  }
  if (
    p.slippageBps !== undefined &&
    (typeof p.slippageBps !== "number" || !Number.isFinite(p.slippageBps))
  ) {
    return false
  }
  if (p.reshield !== undefined && typeof p.reshield !== "boolean") {
    return false
  }
  return true
}

function sendMessage(message: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve))
}

export function Popup() {
  const [hasWallet, setHasWallet] = useState(false)
  const [locked, setLocked] = useState(true)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<{ id: number; origin: string } | null>(null)
  const [pendingSwap, setPendingSwap] = useState<PendingSwap | null>(null)

  useEffect(() => {
    // A storage read throwing in initWallet must not leave the popup stuck on
    // "Loading…" forever (paraloom-core#769). Fall back to the locked/onboarding
    // decision, which re-reads state and always resolves the loading flag.
    initWallet().catch(() => {
      void checkWalletState().catch(() => setLoading(false))
    })
  }, [])

  async function initWallet() {
    const wallet = await getStoredWallet()

    // Stay unlocked across popup opens (Phantom-style) for as long as the idle
    // auto-lock timer allows. The decrypted session lives in memory-only
    // storage.session; restore it so Home has the keys it needs. If it's gone
    // (browser was closed, or auto-lock fired and cleared it), require a re-unlock.
    if (wallet) {
      const isLocked = await isWalletLocked()
      if (!isLocked) {
        const session = await loadSession()
        if (session) {
          const store = useWalletStore.getState()
          store.unlock(session.wallet, session.seedPhrase ?? undefined)
          session.accounts.forEach((a) => store.addAccount(a))
          if (typeof session.currentAccountIndex === "number") {
            store.switchAccount(session.currentAccountIndex)
          }
        } else {
          await setLockState(true)
        }
      }
    }

    await checkWalletState()
  }

  async function checkWalletState() {
    const wallet = await getStoredWallet()
    const isLocked = await isWalletLocked()

    // Resolve any pending dapp connection request BEFORE flipping state, so the
    // first unlocked render already carries it — otherwise Home flashes for one
    // frame between unlock and the pending lookup. (A connection request is only
    // actionable once unlocked.)
    let p: { id: number; origin: string } | null = null
    let ps: PendingSwap | null = null
    if (wallet && !isLocked) {
      const pRaw = (await sendMessage({ type: "GET_PENDING_CONNECTION" })) as unknown
      // Only a real pending request (with a numeric id) counts — never an error
      // object like { success:false, error:"not permitted" }, which would render
      // the approval screen with an undefined id.
      p =
        pRaw &&
        typeof (pRaw as { id?: unknown }).id === "number" &&
        typeof (pRaw as { origin?: unknown }).origin === "string"
          ? (pRaw as { id: number; origin: string })
          : null

      const psRaw = (await sendMessage({ type: "GET_PENDING_SWAP" })) as unknown
      ps = isValidPendingSwap(psRaw) ? psRaw : null
    }

    setHasWallet(!!wallet)
    setPending(p)
    setPendingSwap(ps)
    setLocked(isLocked)
    setLoading(false)
  }

  if (loading) {
    return (
      <div className="app">
        <div className="loading">Loading...</div>
      </div>
    )
  }

  if (!hasWallet) {
    return (
      <div className="app">
        <Onboarding onComplete={() => checkWalletState()} />
      </div>
    )
  }

  if (locked) {
    return (
      <div className="app">
        <Unlock onUnlock={() => checkWalletState()} />
      </div>
    )
  }

  if (pending) {
    return (
      <div className="app">
        <ConnectApprove
          id={pending.id}
          origin={pending.origin}
          onResolved={() => {
            setPending(null)
            void checkWalletState()
          }}
        />
      </div>
    )
  }

  if (pendingSwap) {
    return (
      <div className="app">
        <SwapApprove
          id={pendingSwap.id}
          origin={pendingSwap.origin}
          params={pendingSwap.params}
          onResolved={() => {
            setPendingSwap(null)
            void checkWalletState()
          }}
        />
      </div>
    )
  }

  return (
    <div className="app">
      <Home onLock={() => setLocked(true)} />
    </div>
  )
}

export default Popup

const rootEl = typeof document !== "undefined" ? document.getElementById("root") : null
if (rootEl) {
  const root = createRoot(rootEl)
  root.render(<Popup />)
}
