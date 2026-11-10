import { isValidShieldedAddress } from "./../crypto/addressChecksum"

// ... existing code ...

const toSpendPub = addressSpendPubHex(dest.recipientShielded)
const toBoxPub = addressBoxPubHex(dest.recipientShielded)

if (!isValidShieldedAddress(dest.recipientShielded)) {
  throw new Error("Recipient shielded address failed checksum validation: " + dest.recipientShielded)
}

// ... rest of the code ...