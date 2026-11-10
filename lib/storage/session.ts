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
export const toHex = (u: Uint8Array): string =>
  Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("")

export const fromHex = (h: string, expectedLen?: number): Uint8Array => {
  if (typeof h !== "string") {
    throw new Error("Invalid hex string: input must be a string")
  }
  const clean = h.startsWith("0x") ? h.slice(2) : h
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error("Invalid hex string: must contain valid hexadecimal characters with even length")
  }
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  if (expectedLen !== undefined && out.length !== expectedLen) {
    throw new Error(`Invalid key length: expected ${expectedLen} bytes, got ${out.length}`)
  }
  return out
}

export interface SerKeyPair {
  publicKey: string
  secretKey: string
  shieldedAddress: string
  boxPublicKey: string
  boxSecretKey: string
  spendPrivkey: string
}

export interface SerAccount {
  index: number
  name: string
  keypair: SerKeyPair
  balance: string
}

export interface SerSession {
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

export const serKp = (k: WalletKeyPair): SerKeyPair => {
  if (!k || typeof k !== "object") {
    throw new Error("Invalid WalletKeyPair")
  }
  if (
    !k.publicKey || k.publicKey.length !== 32 ||
    !k.secretKey || k.secretKey.length !== 64 ||
    !k.boxPublicKey || k.boxPublicKey.length !== 32 ||
    !k.boxSecretKey || k.boxSecretKey.length !== 32 ||
    !k.spendPrivkey || k.spendPrivkey.length !== 32
  ) {
    throw new Error("Invalid key length in WalletKeyPair")
  }
  if (typeof k.shieldedAddress !== "string" || !k.shieldedAddress) {
    throw new Error("Invalid shieldedAddress: expected non-empty string")
  }
  return {
    publicKey: toHex(k.publicKey),
    secretKey: toHex(k.secretKey),
    shieldedAddress: k.shieldedAddress,
    boxPublicKey: toHex(k.boxPublicKey),
    boxSecretKey: toHex(k.boxSecretKey),
    spendPrivkey: toHex(k.spendPrivkey)
  }
}

export const deKp = (s: SerKeyPair): WalletKeyPair => {
  if (!s || typeof s !== "object") {
    throw new Error("Invalid keypair: expected object")
  }
  if (typeof s.shieldedAddress !== "string" || !s.shieldedAddress) {
    throw new Error("Invalid shieldedAddress: expected non-empty string")
  }
  return {
    publicKey: fromHex(s.publicKey, 32),
    secretKey: fromHex(s.secretKey, 64),
    shieldedAddress: s.shieldedAddress,
    boxPublicKey: fromHex(s.boxPublicKey, 32),
    boxSecretKey: fromHex(s.boxSecretKey, 32),
    spendPrivkey: fromHex(s.spendPrivkey, 32)
  }
}

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
  try {
    const result = await chrome.storage.session.get(SESSION_KEY)
    const ser = result?.[SESSION_KEY] as SerSession | undefined
    if (!ser) return null
    if (typeof ser !== "object" || !ser.wallet || !Array.isArray(ser.accounts)) {
      await clearSession()
      return null
    }
    const wallet = deKp(ser.wallet)
    const accounts: Account[] = ser.accounts.map((a) => {
      if (!a || typeof a !== "object" || !a.keypair || typeof a.balance !== "string") {
        throw new Error("Invalid account entry in session")
      }
      return {
        index: a.index,
        name: a.name,
        keypair: deKp(a.keypair),
        balance: BigInt(a.balance)
      }
    })
    return {
      wallet,
      accounts,
      currentAccountIndex: typeof ser.currentAccountIndex === "number" ? ser.currentAccountIndex : 0,
      seedPhrase: typeof ser.seedPhrase === "string" ? ser.seedPhrase : null
    }
  } catch (_err) {
    try {
      await clearSession()
    } catch {
      // ignore secondary errors during clear
    }
    return null
  }
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
