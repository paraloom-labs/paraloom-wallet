import type { WalletKeyPair } from "~lib/crypto/keyManagement"
import { create } from "zustand"

export interface Account {
  index: number
  name: string
  keypair: WalletKeyPair
  balance: bigint
}

interface WalletState {
  wallet: WalletKeyPair | null
  locked: boolean
  balance: bigint
  lastActivity: number
  accounts: Account[]
  currentAccountIndex: number
  seedPhrase: string | null

  setWallet: (wallet: WalletKeyPair) => void
  lock: () => void
  unlock: (wallet: WalletKeyPair, seedPhrase?: string) => void
  setBalance: (balance: bigint) => void
  updateActivity: () => void
  clear: () => void
  addAccount: (account: Account) => void
  switchAccount: (index: number) => void
  setSeedPhrase: (seedPhrase: string) => void
}

export const useWalletStore = create<WalletState>()((set, get) => ({
  wallet: null,
  locked: true,
  balance: 0n,
  lastActivity: Date.now(),
  accounts: [],
  currentAccountIndex: 0,
  seedPhrase: null,

  setWallet: (wallet) =>
    set({
      wallet,
      locked: false,
      lastActivity: Date.now()
    }),

  lock: () =>
    set({
      wallet: null,
      locked: true,
      seedPhrase: null,
      accounts: [],
      currentAccountIndex: 0
    }),

  unlock: (wallet, seedPhrase) =>
    set({
      wallet,
      locked: false,
      lastActivity: Date.now(),
      seedPhrase: seedPhrase || get().seedPhrase
    }),

  setBalance: (balance) => {
    const state = get()
    const accounts = state.accounts.map((a) =>
      a.index === state.currentAccountIndex ? { ...a, balance } : a
    )
    set({ balance, accounts })
  },

  updateActivity: () => set({ lastActivity: Date.now() }),

  clear: () =>
    set({
      wallet: null,
      locked: true,
      balance: 0n,
      lastActivity: Date.now(),
      accounts: [],
      currentAccountIndex: 0,
      seedPhrase: null
    }),

  addAccount: (account) => {
    const state = get()
    // Check if account already exists to avoid duplicates, update if exists
    const exists = state.accounts.some((a) => a.index === account.index)
    if (exists) {
      set({
        accounts: state.accounts.map((a) => (a.index === account.index ? account : a)),
        ...(state.currentAccountIndex === account.index ? { balance: account.balance } : {})
      })
    } else {
      set({
        accounts: [...state.accounts, account]
      })
    }
  },

  switchAccount: (index) => {
    const state = get()
    const account = state.accounts.find((a) => a.index === index)
    if (account) {
      set({
        currentAccountIndex: index,
        wallet: account.keypair,
        balance: account.balance
      })
    }
  },

  setSeedPhrase: (seedPhrase) => set({ seedPhrase })
}))
