// Sealed at-rest storage for the wallet's bearer secrets (#1724).
//
// The swap fresh-address secret keys (`lib/paraloom/swapOutputs.ts`) and the
// shielded-note blindings (`lib/paraloom/notes.ts`) used to be written in
// plaintext to `chrome.storage.local`, readable while the wallet was locked.
// They are now sealed with NaCl secretbox (XSalsa20-Poly1305, the same cipher
// as the password vault) under a wallet-derived key and stored as one opaque
// blob per store.
//
// The sealing key is derived from the unlocked session's primary keypair
// (domain-separated SHA-256 over the account seed, the first 32 bytes of the
// secret key) and re-derived from the live session on every read/write — it
// is never written to disk. `LOCK_WALLET` clears the session, so a locked
// wallet leaves only ciphertext behind: reads return nothing and writes
// refuse until the next unlock. The plaintext-to-sealed migration happens
// lazily on the first unlocked read of a legacy store.

import { sha256 } from "@noble/hashes/sha256"
import { randomBytes } from "@noble/hashes/utils"
import * as nacl from "tweetnacl"
import { loadSession } from "./session"

const SEAL_VERSION = "v1"
// Domain tag for the sealing-key derivation. Deliberately distinct from the
// spend-key tag ("paraloom-spend-v2") so the sealing key is independent of
// every other key derived from the account seed.
const DOMAIN = "paraloom-seal-v1"

// Portable hex helpers (no Buffer) so this module works in both the popup
// and the background service worker, where Buffer may be unavailable.
const toHex = (u: Uint8Array): string =>
  Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("")
const fromHex = (h: string): Uint8Array => {
  const out = new Uint8Array(Math.floor(h.length / 2))
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/**
 * Derive the wallet's sealing key from a secret key. Only the account seed
 * (first 32 bytes) is used, so the key is stable across unlocks and identical
 * for every account of the same wallet — the seed phrase alone recovers it.
 *
 * Invariant: callers pass the session's primary keypair (`session.wallet`),
 * which `saveSession` writes once per unlock from the decrypted vault keypair
 * and never re-saves on account switch, so the derived key cannot change
 * under a sealed store.
 */
export function deriveSealingKey(walletSecretKey: Uint8Array): Uint8Array {
  const seed = walletSecretKey.slice(0, 32)
  const tag = new TextEncoder().encode(DOMAIN)
  const input = new Uint8Array(tag.length + seed.length)
  input.set(tag)
  input.set(seed, tag.length)
  return sha256(input)
}

/** The sealing key for the current unlocked session, or null while locked. */
export async function getSealingKey(): Promise<Uint8Array | null> {
  const session = await loadSession()
  if (!session) return null
  return deriveSealingKey(session.wallet.secretKey)
}

/** True for a blob produced by `sealJson` (as opposed to a legacy plaintext row). */
export function isSealedBlob(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(`${SEAL_VERSION}:`)
}

/**
 * Seal a JSON value under `key`. The returned blob is self-contained —
 * `v1:<hex(nonce || secretbox(json))>` — so the reader needs nothing but
 * the key. A fresh random nonce per write means identical plaintexts seal
 * differently, and re-sealing the same store after an edit leaks nothing
 * about what changed.
 */
export function sealJson(value: unknown, key: Uint8Array): string {
  const nonce = randomBytes(nacl.secretbox.nonceLength)
  const message = new TextEncoder().encode(JSON.stringify(value))
  const boxed = nacl.secretbox(message, nonce, key)
  const combined = new Uint8Array(nonce.length + boxed.length)
  combined.set(nonce)
  combined.set(boxed, nonce.length)
  return `${SEAL_VERSION}:${toHex(combined)}`
}

/**
 * Open a blob produced by `sealJson`. Throws when the blob is malformed or
 * authentication fails — a wrong wallet's key, or tampered ciphertext, must
 * never silently read as an empty store.
 */
export function unsealJson<T>(blob: string, key: Uint8Array): T {
  if (!isSealedBlob(blob)) throw new Error("not a sealed blob")
  const combined = fromHex(blob.slice(SEAL_VERSION.length + 1))
  const nonce = combined.slice(0, nacl.secretbox.nonceLength)
  const boxed = combined.slice(nacl.secretbox.nonceLength)
  const opened = nacl.secretbox.open(boxed, nonce, key)
  if (!opened) {
    throw new Error("sealed blob failed authentication (wrong wallet or tampered data)")
  }
  return JSON.parse(new TextDecoder().decode(opened)) as T
}
