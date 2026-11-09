import { sha256 } from "@noble/hashes/sha256"

// A v2 shielded address is `paraloom1` + a 128-hex body (box pubkey 64 hex +
// spend pubkey 64 hex) + an 8-hex checksum. The checksum closes #781: the body
// carries no self-describing structure, so a length-preserving typo (one wrong
// character, or two swapped) used to pass a length-only check and strand the
// transfer at an address that decrypts to nothing spendable, with no recovery.
// The checksum makes such a typo fail validation before anything is sent.
export const SHIELDED_BODY_HEX = 128
export const SHIELDED_CHECKSUM_HEX = 8

const ZERO_KEY = "0".repeat(64)

export function validateBodyHex(bodyHex: string): string {
  if (
    typeof bodyHex !== "string" ||
    bodyHex.length !== SHIELDED_BODY_HEX ||
    !/^[0-9a-fA-F]{128}$/.test(bodyHex)
  ) {
    throw new Error(
      `Invalid shielded address body: must be a ${SHIELDED_BODY_HEX}-character hex string`
    )
  }
  const normalized = bodyHex.toLowerCase()
  const boxPub = normalized.slice(0, 64)
  const spendPub = normalized.slice(64, 128)
  if (boxPub === ZERO_KEY || spendPub === ZERO_KEY) {
    throw new Error(
      "Invalid shielded address body: box and spend public keys cannot be all-zero"
    )
  }
  if (boxPub === spendPub) {
    throw new Error(
      "Invalid shielded address body: box and spend public keys must be distinct"
    )
  }
  return normalized
}

// 8-hex checksum over the 64 raw payload bytes (box || spend): the first 4 bytes
// of their SHA-256, Bitcoin-style. 32 bits, so a random corruption slips through
// only ~1 in 4 billion.
export function shieldedChecksum(bodyHex: string): string {
  const normalized = validateBodyHex(bodyHex)
  const bytes = Uint8Array.from(Buffer.from(normalized, "hex"))
  return Buffer.from(sha256(bytes).slice(0, 4)).toString("hex")
}

// Append the checksum to a 128-hex body, producing the address suffix after the
// `paraloom1` prefix.
export function withChecksum(bodyHex: string): string {
  const normalized = validateBodyHex(bodyHex)
  return normalized + shieldedChecksum(normalized)
}

// Validate a full `paraloom1…` address and return its 128-hex body, or null if
// the prefix, length, hex, or checksum is wrong. A checksum-less legacy address
// (128-hex body, no checksum) is rejected by design: accepting it would let the
// exact typo this guards against back in.
export function parseShieldedAddress(addr: string): string | null {
  if (typeof addr !== "string") return null
  if (!addr.startsWith("paraloom1")) return null
  const rest = addr.slice("paraloom1".length)
  if (rest.length !== SHIELDED_BODY_HEX + SHIELDED_CHECKSUM_HEX) return null
  if (!/^[0-9a-fA-F]+$/.test(rest)) return null
  const body = rest.slice(0, SHIELDED_BODY_HEX).toLowerCase()
  const boxPub = body.slice(0, 64)
  const spendPub = body.slice(64, 128)
  if (boxPub === ZERO_KEY || spendPub === ZERO_KEY) return null
  if (boxPub === spendPub) return null

  const csum = rest.slice(SHIELDED_BODY_HEX).toLowerCase()
  try {
    if (shieldedChecksum(body) !== csum) return null
  } catch {
    return null
  }
  return body
}

export function isValidShieldedAddress(addr: string): boolean {
  return parseShieldedAddress(addr) !== null
}
