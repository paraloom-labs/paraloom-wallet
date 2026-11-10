import { isValidShieldedAddress } from "./../crypto/addressChecksum"

// ... existing code ...

if (!isValidShieldedAddress(recipientShieldedAddress)) {
  throw new Error("Recipient shielded address failed checksum validation: " + recipientShieldedAddress)
}

// ... rest of the code ...