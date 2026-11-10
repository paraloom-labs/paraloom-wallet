import { parseShieldedAddress } from "./addressChecksum"

export function addressBoxPubHex(shieldedAddress: string): string {
  const body = parseShieldedAddress(shieldedAddress)
  if (!body) {
    throw new Error("Invalid shielded address or checksum mismatch: " + shieldedAddress)
  }
  return body.slice(0, 64)
}

export function addressSpendPubHex(shieldedAddress: string): string {
  const body = parseShieldedAddress(shieldedAddress)
  if (!body) {
    throw new Error("Invalid shielded address or checksum mismatch: " + shieldedAddress)
  }
  return body.slice(64, 128)
}