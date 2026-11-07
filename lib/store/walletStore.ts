import { create } from "zustand"
import type { WalletKeyPair } from "~lib/crypto/keyManagement"

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
      currentAccountIndex: 0,
      seedPhrase: seedPhrase || get().seedPhrase
    }),

  setBalance: (balance) => set({ balance }),

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
    const existingIdx = state.accounts.findIndex(a => a.index === account.index)
    if (existingIdx >= 0) {
      const next = [...state.accounts]
      next[existingIdx] = account
      set({ accounts: next })
    } else {
      set({
        accounts: [...state.accounts, account]
      })
    }
  },

  switchAccount: (index) => {
    const state = get()
    const account = state.accounts.find(a => a.index === index)
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
