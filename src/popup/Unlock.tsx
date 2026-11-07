import { useEffect, useState } from "react"
import {
  decryptWallet,
  decryptSeedPhrase,
  deriveKeypairFromSeed,
  encryptWallet,
  KDF_VERSION_SCRYPT
} from "~lib/crypto/keyManagement"
import {
  getStoredWallet,
  migrateWalletToScrypt,
  setLockState
} from "~lib/storage/secure"
import { saveSession } from "~lib/storage/session"
import { useWalletStore } from "~lib/store/walletStore"
import type { Account } from "~lib/store/walletStore"
import type { WalletKeyPair } from "~lib/crypto/keyManagement"
import logoImg from "data-base64:~/../assets/icon.png"

const MAX_ATTEMPTS = 5
const LOCKOUT_SECONDS = 30

function safeParseBigInt(val: unknown): bigint {
  if (typeof val === "bigint") return val >= 0n ? val : 0n
  if (typeof val === "string" && /^\d+$/.test(val.trim())) {
    return BigInt(val.trim())
  }
  return 0n
}

interface UnlockProps {
  onUnlock: () => void
}

export function Unlock({ onUnlock }: UnlockProps) {
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [attempts, setAttempts] = useState(0)
  const [lockedUntil, setLockedUntil] = useState(0)
  const [nowTick, setNowTick] = useState(() => Date.now())
  const { unlock, setSeedPhrase, addAccount } = useWalletStore()

  useEffect(() => {
    if (lockedUntil <= Date.now()) return
    const id = setInterval(() => {
      const now = Date.now()
      setNowTick(now)
      if (now >= lockedUntil) {
        setLockedUntil(0)
        setError("")
      }
    }, 1000)
    return () => clearInterval(id)
  }, [lockedUntil])

  const isLockedOut = nowTick < lockedUntil
  const remainingSeconds = isLockedOut
    ? Math.ceil((lockedUntil - nowTick) / 1000)
    : 0

  async function handleUnlock() {
    if (isLockedOut) return
    setError("")
    setLoading(true)

    const stored = await getStoredWallet()
    if (!stored) {
      setError("No wallet found")
      setLoading(false)
      return
    }

    // Vaults written before the scrypt migration have no kdfVersion and
    // must be decrypted with the legacy SHA-256 KDF.
    const isLegacy = (stored.kdfVersion ?? 0) < KDF_VERSION_SCRYPT
    let wallet: WalletKeyPair
    try {
      wallet = await decryptWallet(stored.encryptedData, password, isLegacy)
    } catch {
      const newAttempts = attempts + 1
      setAttempts(newAttempts)

      if (newAttempts >= MAX_ATTEMPTS) {
        const until = Date.now() + LOCKOUT_SECONDS * 1000
        setNowTick(Date.now())
        setLockedUntil(until)
        setError(`Too many attempts. Try again in ${LOCKOUT_SECONDS}s`)
        setAttempts(0)
      } else {
        setError(`Invalid password (${MAX_ATTEMPTS - newAttempts} attempts remaining)`)
      }

      setPassword("")
      setLoading(false)
      return
    }

    try {
      let seedPhrase: string | undefined
      if (stored.encryptedSeedPhrase) {
        try {
          seedPhrase = decryptSeedPhrase(stored.encryptedSeedPhrase, password, isLegacy)
        } catch {}
      }

      // Transparently upgrade legacy vaults to scrypt now that the password
      // is confirmed correct. Best-effort: a failure here doesn't block unlock.
      if (isLegacy) {
        try {
          const upgraded = encryptWallet(wallet, password)
          await migrateWalletToScrypt(upgraded, seedPhrase, password)
        } catch {}
      }

      if (stored.accounts && stored.accounts.length > 0 && seedPhrase) {
        for (const storedAccount of stored.accounts) {
          try {
            const keypair = await deriveKeypairFromSeed(seedPhrase, storedAccount.index)
            const account: Account = {
              index: storedAccount.index,
              name: storedAccount.name,
              keypair,
              balance: safeParseBigInt(storedAccount.balance)
            }
            addAccount(account)
          } catch {}
        }
      }

      unlock(wallet, seedPhrase)
      await setLockState(false)
      setAttempts(0)

      // Persist the decrypted session in memory-only storage so reopening the
      // popup doesn't force a re-unlock (the idle auto-lock timer still applies).
      const st = useWalletStore.getState()
      await saveSession({
        wallet,
        accounts: st.accounts,
        currentAccountIndex: st.currentAccountIndex,
        seedPhrase: seedPhrase ?? st.seedPhrase
      })

      chrome.runtime.sendMessage({ type: "ACTIVITY" })
      onUnlock()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to restore wallet session")
      setLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      handleUnlock()
    }
  }

  return (
    <div className="unlock-layout">
      <div className="unlock-hero">
        <img src={logoImg} alt="paraloom" className="unlock-logo" />
        <div className="unlock-brand">
          <span className="unlock-wordmark">paraloom</span>
          <span className="unlock-greeting">Welcome back</span>
        </div>
      </div>

      <div className="unlock-form">
        <div className="unlock-input-group">
          <label className="unlock-label">Enter your password</label>
          <input
            type="password"
            className={`input unlock-input ${error ? 'input-error shake' : ''}`}
            placeholder="••••••••"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value)
              if (error) setError("")
            }}
            onKeyDown={handleKeyDown}
            autoFocus
            disabled={isLockedOut}
          />
          {error && <div className="unlock-attempts">{error}</div>}
        </div>

        <button className="button" onClick={handleUnlock} disabled={loading || isLockedOut || !password}>
          {loading ? (
            <><span className="spinner" /> Unlocking...</>
          ) : isLockedOut ? (
            `Locked (${remainingSeconds}s)`
          ) : (
            "Unlock"
          )}
        </button>
      </div>

      <div className="unlock-footer">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
        <span>Your wallet is encrypted locally</span>
      </div>
    </div>
  )
}
