// Private swap-out outputs. A private swap leaves the bought token at a FRESH,
// unlinkable address whose key the wallet generated. That key never leaves the
// wallet, so it must be persisted here or the token would be unrecoverable.
// Stored in extension-local storage (not synced).
//
// #298: swap outputs (including `freshSecretKeyHex`) used to sit in
// `chrome.storage.local` as plain JSON, readable by anything with local access
// to the browser profile without the wallet password, and never expired. They
// are now stored inside a NaCl `secretbox` envelope encrypted with a
// domain-separated key derived from the unlocked session's vault key material
// (`swapOutputsEncryptionKey`), with automatic scrubbing of `freshSecretKeyHex`
// once re-shield recovery completes and TTL garbage collection for expired rows.

import { sha256 } from "@noble/hashes/sha256"
import * as nacl from "tweetnacl"

import { loadSession } from "~lib/storage/session"

export interface SwapOutput {
  /** The fresh, unlinkable address holding the swapped token. */
  freshAddress: string
  /** Secret key (hex) of the fresh address — needed to move the token later. */
  freshSecretKeyHex: string
  /** Output mint (base58) or "SOL". */
  outputMint: string
  /** Output amount the route reported, in the out mint's base units. */
  outAmount: number
  /** The swap transaction signature. Empty until the swap leg completes; a
   *  non-empty value marks the swap done (used to find resumable strands). */
  swapSignature: string
  /** Whether the user asked to re-shield the bought token (a round trip). Saved
   *  so a resumed/recovered swap honors the original intent. */
  reshield?: boolean
  /** Set once the re-shield note has been persisted (either normally or via the
   *  recovery scan), so recovery does not re-scan a settled reshield each connect. */
  reshieldRecovered?: boolean
  createdAt: number
}

const KEY = "paraloom_swap_outputs"
const SWAP_OUTPUTS_KEY_DOMAIN = "paraloom-swap-outputs-v1"

/** Default retention period (30 days) before completed re-shielded or abandoned
 *  unsubmitted rows are garbage-collected. Rows still holding un-shielded
 *  tokens at the fresh address are never auto-deleted. */
export const SWAP_OUTPUT_TTL_MS = 30 * 24 * 60 * 60 * 1000

const toHex = (u: Uint8Array): string =>
  Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("")
const fromHex = (h: string): Uint8Array => {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

async function swapOutputsEncryptionKey(): Promise<Uint8Array | null> {
  const session = await loadSession()
  if (!session) return null
  const tag = new TextEncoder().encode(SWAP_OUTPUTS_KEY_DOMAIN)
  const input = new Uint8Array(tag.length + session.wallet.spendPrivkey.length)
  input.set(tag)
  input.set(session.wallet.spendPrivkey, tag.length)
  return sha256(input)
}

interface EncryptedSwapOutputsEnvelope {
  v: 1
  nonce: string // hex
  ciphertext: string // hex
}

function isEnvelope(value: unknown): value is EncryptedSwapOutputsEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as EncryptedSwapOutputsEnvelope).v === 1 &&
    typeof (value as EncryptedSwapOutputsEnvelope).nonce === "string" &&
    typeof (value as EncryptedSwapOutputsEnvelope).ciphertext === "string"
  )
}

function sanitizeAndPrune(rows: SwapOutput[], now = Date.now()): SwapOutput[] {
  return rows
    .filter((o) => {
      const expired = now - o.createdAt > SWAP_OUTPUT_TTL_MS
      if (expired && o.reshieldRecovered) return false
      return true
    })
    .map((o) => (o.reshieldRecovered ? { ...o, freshSecretKeyHex: "" } : o))
}

async function readAll(): Promise<SwapOutput[]> {
  const stored = await chrome.storage.local.get(KEY)
  const raw = stored[KEY]
  if (raw === undefined) return []
  if (isEnvelope(raw)) {
    const key = await swapOutputsEncryptionKey()
    if (!key) {
      throw new Error(
        "Wallet is locked: swap outputs are encrypted and the wallet must be unlocked to read them"
      )
    }
    const decrypted = nacl.secretbox.open(fromHex(raw.ciphertext), fromHex(raw.nonce), key)
    if (!decrypted) {
      throw new Error("Stored swap outputs could not be decrypted (tampered or wrong wallet)")
    }
    const parsed = JSON.parse(new TextDecoder().decode(decrypted)) as SwapOutput[]
    return sanitizeAndPrune(parsed)
  }
  // Legacy plaintext array (pre-#298): migrate to the encrypted envelope on the
  // first unlocked read so plaintext keys do not survive on disk.
  const legacy = sanitizeAndPrune(Array.isArray(raw) ? (raw as SwapOutput[]) : [])
  if (await swapOutputsEncryptionKey()) {
    await writeAll(legacy)
  }
  return legacy
}

async function writeAll(all: SwapOutput[]): Promise<void> {
  const key = await swapOutputsEncryptionKey()
  if (!key) {
    throw new Error("Wallet is locked: swap outputs cannot be saved while locked")
  }
  const cleaned = sanitizeAndPrune(all)
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength)
  const message = new TextEncoder().encode(JSON.stringify(cleaned))
  const ciphertext = nacl.secretbox(message, nonce, key)
  const envelope: EncryptedSwapOutputsEnvelope = {
    v: 1,
    nonce: toHex(nonce),
    ciphertext: toHex(ciphertext)
  }
  await chrome.storage.local.set({ [KEY]: envelope })
}

// Upsert by freshAddress: the key is saved early (before the withdraw) so it can
// never be lost, then the same entry is updated with the realized amount +
// signature once the swap lands. Keyed on the address so the two writes collapse
// to one row.
export async function saveSwapOutput(output: SwapOutput): Promise<void> {
  const current = await readAll()
  const i = current.findIndex((o) => o.freshAddress === output.freshAddress)
  if (i >= 0) current[i] = { ...current[i], ...output }
  else current.push(output)
  await writeAll(current)
}

export async function listSwapOutputs(): Promise<SwapOutput[]> {
  return readAll()
}

// Drop a swap row by its fresh address. Used to clear a stale "pending" row the
// reconciler could not positively account for — the funds are already safe (the
// swap either re-shielded into the pool or its input note was never spent), so
// this only removes the misleading Activity entry, never any money.
export async function dismissSwapOutput(freshAddress: string): Promise<void> {
  const current = await readAll()
  const next = current.filter((o) => o.freshAddress !== freshAddress)
  await writeAll(next)
}
