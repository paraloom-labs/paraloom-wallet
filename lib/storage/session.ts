import type { WalletKeyPair } from "~lib/crypto/keyManagement"
import type { Account } from "~lib/store/walletStore"

// The decrypted wallet for the current unlocked session, held in
// chrome.storage.session — an in-memory area that is NEVER written to disk and
// is cleared automatically when the browser fully closes. This lets the popup
// (and a respawned MV3 service worker) reopen without re-prompting for the
// password, while the existing idle auto-lock timer still re-locks after
// `autoLockMinutes`. Closing the popup no longer drops the unlocked state.
const SESSION_KEY = "paraloom_session"

// Last-activity timestamp for auto-lock. Kept in chrome.storage.session, not a
// service-worker module variable: under MV3 the worker is killed after ~30s
// idle and respawned on the next message without re-running top-level init, so
// a module var resets to "just now" on every wake and the idle clock never
// advances. Session storage is memory-only (never on disk, cleared on browser
// exit) and survives worker restarts within a session, which is exactly the
// lifetime auto-lock needs.
const ACTIVITY_KEY = "paraloom_last_activity"

// Portable hex helpers (no Buffer) so this module works in both the popup and
// the background service worker, where Buffer may be unavailable.
const toHex = (u: Uint8Array): string =>
  Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("")
const fromHex = (h: string): Uint8Array => {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

interface SerKeyPair {
  publicKey: string
  secretKey: string
  shieldedAddress: string
  boxPublicKey: string
  boxSecretKey: string
  spendPrivkey: string
}

interface SerAccount {
  index: number
  name: string
  keypair: SerKeyPair
  balance: string
}

interface SerSession {
  wallet: SerKeyPair
  accounts: SerAccount[]
  currentAccountIndex: number
  seedPhrase: string | null
}

export interface WalletSession {
  wallet: WalletKeyPair
  accounts: Account[]
  currentAccountIndex: number
  seedPhrase: string | null
}

const serKp = (k: WalletKeyPair): SerKeyPair => ({
  publicKey: toHex(k.publicKey),
  secretKey: toHex(k.secretKey),
  shieldedAddress: k.shieldedAddress,
  boxPublicKey: toHex(k.boxPublicKey),
  boxSecretKey: toHex(k.boxSecretKey),
  spendPrivkey: toHex(k.spendPrivkey)
})

const deKp = (s: SerKeyPair): WalletKeyPair => ({
  publicKey: fromHex(s.publicKey),
  secretKey: fromHex(s.secretKey),
  shieldedAddress: s.shieldedAddress,
  boxPublicKey: fromHex(s.boxPublicKey),
  boxSecretKey: fromHex(s.boxSecretKey),
  spendPrivkey: fromHex(s.spendPrivkey)
})

export async function saveSession(session: WalletSession): Promise<void> {
  const ser: SerSession = {
    wallet: serKp(session.wallet),
    accounts: session.accounts.map((a) => ({
      index: a.index,
      name: a.name,
      keypair: serKp(a.keypair),
      balance: a.balance.toString()
    })),
    currentAccountIndex: session.currentAccountIndex,
    seedPhrase: session.seedPhrase
  }
  // Start the auto-lock clock at unlock. Without this the first idle check
  // after unlock finds no timestamp; seeding here means the clock always begins
  // the moment the session exists, whoever created it.
  await chrome.storage.session.set({ [SESSION_KEY]: ser, [ACTIVITY_KEY]: Date.now() })
}

export async function loadSession(): Promise<WalletSession | null> {
  const result = await chrome.storage.session.get(SESSION_KEY)
  const ser = result[SESSION_KEY] as SerSession | undefined
  if (!ser) return null
  const accounts: Account[] = ser.accounts.map((a) => ({
    index: a.index,
    name: a.name,
    keypair: deKp(a.keypair),
    balance: BigInt(a.balance)
  }))
  const currentAccountIndex = ser.currentAccountIndex ?? 0
  const activeAccount = accounts.find((a) => a.index === currentAccountIndex)
  return {
    wallet: activeAccount ? activeAccount.keypair : deKp(ser.wallet),
    accounts,
    currentAccountIndex,
    seedPhrase: ser.seedPhrase
  }
}

export async function updateSessionAccount(
  currentAccountIndex: number,
  accounts?: Account[]
): Promise<void> {
  const result = await chrome.storage.session.get(SESSION_KEY)
  const ser = result[SESSION_KEY] as SerSession | undefined
  if (!ser) return
  const nextAccounts = accounts
    ? accounts.map((a) => ({
        index: a.index,
        name: a.name,
        keypair: serKp(a.keypair),
        balance: a.balance.toString()
      }))
    : ser.accounts
  const active = nextAccounts.find((a) => a.index === currentAccountIndex)
  const updated: SerSession = {
    ...ser,
    wallet: active ? active.keypair : ser.wallet,
    accounts: nextAccounts,
    currentAccountIndex
  }
  await chrome.storage.session.set({ [SESSION_KEY]: updated, [ACTIVITY_KEY]: Date.now() })
}

export async function clearSession(): Promise<void> {
  await chrome.storage.session.remove([SESSION_KEY, ACTIVITY_KEY])
}

export async function recordActivity(now: number): Promise<void> {
  await chrome.storage.session.set({ [ACTIVITY_KEY]: now })
}

export async function getLastActivity(): Promise<number | null> {
  const result = await chrome.storage.session.get(ACTIVITY_KEY)
  const ts = result[ACTIVITY_KEY]
  return typeof ts === "number" ? ts : null
}
