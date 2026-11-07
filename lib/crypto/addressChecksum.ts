import { sha256 } from "@noble/hashes/sha256"

// A v2 shielded address is `paraloom1` + a 128-hex body (box pubkey 64 hex +
// spend pubkey 64 hex) + an 8-hex checksum. The checksum closes #781: the body
// carries no self-describing structure, so a length-preserving typo (one wrong
// character, or two swapped) used to pass a length-only check and strand the
// transfer at an address that decrypts to nothing spendable, with no recovery.
// The checksum makes such a typo fail validation before anything is sent.
export const SHIELDED_BODY_HEX = 128
export const SHIELDED_CHECKSUM_HEX = 8

const ZERO_HEX_64 = "0".repeat(64)

function isValidBodyHex(bodyHex: string): boolean {
  if (typeof bodyHex !== "string" || bodyHex.length !== SHIELDED_BODY_HEX) return false
  if (!/^[0-9a-fA-F]+$/.test(bodyHex)) return false
  const lower = bodyHex.toLowerCase()
  const boxPub = lower.slice(0, 64)
  const spendPub = lower.slice(64, 128)
  if (boxPub === ZERO_HEX_64 || spendPub === ZERO_HEX_64) return false
  return true
}

// 8-hex checksum over the 64 raw payload bytes (box || spend): the first 4 bytes
// of their SHA-256, Bitcoin-style. 32 bits, so a random corruption slips through
// only ~1 in 4 billion.
export function shieldedChecksum(bodyHex: string): string {
  if (!isValidBodyHex(bodyHex)) {
    throw new Error("invalid shielded address body")
  }
  const bytes = Uint8Array.from(Buffer.from(bodyHex, "hex"))
  return Buffer.from(sha256(bytes).slice(0, 4)).toString("hex")
}

// Append the checksum to a 128-hex body, producing the address suffix after the
// `paraloom1` prefix.
export function withChecksum(bodyHex: string): string {
  const lower = bodyHex.toLowerCase()
  return lower + shieldedChecksum(lower)
}

// Validate a full `paraloom1…` address and return its 128-hex body, or null if
// the prefix, length, hex, or checksum is wrong. A checksum-less legacy address
// (128-hex body, no checksum) is rejected by design: accepting it would let the
// exact typo this guards against back in.
export function parseShieldedAddress(addr: string): string | null {
  if (typeof addr !== "string" || !addr.startsWith("paraloom1")) return null
  const rest = addr.slice("paraloom1".length)
  if (rest.length !== SHIELDED_BODY_HEX + SHIELDED_CHECKSUM_HEX) return null
  if (!/^[0-9a-fA-F]+$/.test(rest)) return null
  const body = rest.slice(0, SHIELDED_BODY_HEX).toLowerCase()
  if (!isValidBodyHex(body)) return null
  const csum = rest.slice(SHIELDED_BODY_HEX).toLowerCase()
  if (shieldedChecksum(body) !== csum) return null
  return body
}

export function isValidShieldedAddress(addr: string): boolean {
  return parseShieldedAddress(addr) !== null
}
