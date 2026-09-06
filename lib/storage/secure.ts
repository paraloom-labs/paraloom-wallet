import type { EncryptedWallet } from "~lib/crypto/keyManagement"
import { encryptSeedPhrase, KDF_VERSION_SCRYPT } from "~lib/crypto/keyManagement"
import type { Account } from "~lib/store/walletStore"

export interface SerializableAccount {
  index: number
  name: string
  address: string
  balance: string
}

export interface StoredWallet {
  encryptedData: EncryptedWallet
  address: string
  createdAt: number
  encryptedSeedPhrase?: string
  accounts?: SerializableAccount[]
  // KDF used for encryptedData + encryptedSeedPhrase. Both blobs are always
  // written together, so one marker covers both. Absent = legacy SHA-256 chain.
  kdfVersion?: number
}

export interface WalletStorage {
  wallet?: StoredWallet
  locked: boolean
  autoLockMinutes: number
  network?: "mainnet-beta" | "devnet"
}

export const STORAGE_KEY = "paraloom_wallet"

export async function saveEncryptedWallet(
  encryptedWallet: EncryptedWallet,
  address: string,
  seedPhrase?: string,
  password?: string,
  accounts?: Account[]
): Promise<void> {
  const data: StoredWallet = {
    encryptedData: encryptedWallet,
    address,
    createdAt: Date.now(),
    kdfVersion: KDF_VERSION_SCRYPT
  }

  // Encrypt and save seed phrase if provided
  if (seedPhrase && password) {
    data.encryptedSeedPhrase = encryptSeedPhrase(seedPhrase, password)
  }

  // Serialize accounts if provided (convert keypair to address, balance to string)
  if (accounts && accounts.length > 0) {
    data.accounts = accounts.map(acc => ({
      index: acc.index,
      name: acc.name,
      address: acc.keypair.shieldedAddress,
      balance: acc.balance.toString()
    }))
  }

  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      wallet: data,
      locked: true,
      autoLockMinutes: 60
    }
  })
}

/**
 * Re-encrypt an already-unlocked wallet under the current (scrypt) KDF,
 * updating only the wallet blobs + kdfVersion and preserving every other
 * stored setting (lock state, auto-lock minutes, network).
 * Used to transparently upgrade legacy vaults on first unlock.
 */
export async function migrateWalletToScrypt(
  encryptedWallet: EncryptedWallet,
  seedPhrase: string | undefined,
  password: string
): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  const storage = result[STORAGE_KEY] as WalletStorage | undefined
  if (!storage?.wallet) return

  storage.wallet.encryptedData = encryptedWallet
  storage.wallet.kdfVersion = KDF_VERSION_SCRYPT
  if (seedPhrase) {
    storage.wallet.encryptedSeedPhrase = encryptSeedPhrase(seedPhrase, password)
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: storage })
}

export async function getStoredWallet(): Promise<StoredWallet | null> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  const storage = result[STORAGE_KEY] as WalletStorage | undefined
  return storage?.wallet || null
}

export async function clearWallet(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY)
}

export async function isWalletLocked(): Promise<boolean> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  const storage = result[STORAGE_KEY] as WalletStorage | undefined
  return storage?.locked ?? true
}

export async function setLockState(locked: boolean): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  const storage = result[STORAGE_KEY] as WalletStorage

  if (storage) {
    storage.locked = locked
    await chrome.storage.local.set({ [STORAGE_KEY]: storage })
  }
}

export async function getAutoLockMinutes(): Promise<number> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  const storage = result[STORAGE_KEY] as WalletStorage | undefined
  return storage?.autoLockMinutes ?? 60
}

export async function setAutoLockMinutes(minutes: number): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  const storage = result[STORAGE_KEY] as WalletStorage

  if (storage) {
    storage.autoLockMinutes = minutes
    await chrome.storage.local.set({ [STORAGE_KEY]: storage })
  }
}

export async function updateAccounts(accounts: Account[]): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  const storage = result[STORAGE_KEY] as WalletStorage

  if (storage?.wallet) {
    storage.wallet.accounts = accounts.map(acc => ({
      index: acc.index,
      name: acc.name,
      address: acc.keypair.shieldedAddress,
      balance: acc.balance.toString()
    }))
    await chrome.storage.local.set({ [STORAGE_KEY]: storage })
  }
}

export async function getNetwork(): Promise<"mainnet-beta" | "devnet"> {
  // Mainnet is live (capped beta). New installs default to mainnet-beta;
  // a previously stored choice (e.g. devnet for testing) is honoured.
  const result = await chrome.storage.local.get(STORAGE_KEY)
  const storage = result[STORAGE_KEY] as WalletStorage | undefined
  return storage?.network ?? "mainnet-beta"
}

export async function setNetwork(network: "mainnet-beta" | "devnet"): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  const storage = result[STORAGE_KEY] as WalletStorage

  if (storage) {
    storage.network = network
    await chrome.storage.local.set({ [STORAGE_KEY]: storage })
  }
}
