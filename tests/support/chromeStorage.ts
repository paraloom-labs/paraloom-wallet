// Minimal in-memory stand-in for the parts of `chrome.storage` the wallet
// touches. Deliberately not a mock library: the storage modules only use
// get/set/remove, and a real object keeps the tests honest about what is
// actually persisted (a `vi.fn()` returning a canned value would let a module
// pass while writing nothing).
//
// Both directions clone. `chrome.storage` is a structured-clone boundary, so a
// reader cannot reach the stored object: code that mutates what it read and
// forgets to call `set` loses the change in production, and must lose it here
// too. Returning the live object instead would hide exactly the missing write
// this fake exists to catch.

type Store = Record<string, unknown>

/** Stand-in for the structured clone `chrome.storage` performs. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export interface FakeArea {
  get(key: string | string[] | null): Promise<Store>
  set(items: Store): Promise<void>
  remove(key: string | string[]): Promise<void>
  /** Test-only: the raw backing object, for asserting what was written. */
  readonly raw: Store
}

function makeArea(): FakeArea {
  const store: Store = {}
  return {
    async get(key) {
      const snapshot = clone(store)
      if (key === null || key === undefined) return snapshot
      const keys = Array.isArray(key) ? key : [key]
      const out: Store = {}
      for (const k of keys) {
        if (k in snapshot) out[k] = snapshot[k]
      }
      return out
    },
    async set(items) {
      // Cloning on the way in also pins the serialization: a module that
      // stores a Uint8Array or a bigint and reads it back unchanged would be
      // lying about production behaviour.
      Object.assign(store, clone(items))
    },
    async remove(key) {
      for (const k of Array.isArray(key) ? key : [key]) delete store[k]
    },
    get raw() {
      return store
    }
  }
}

export interface FakeChrome {
  storage: { local: FakeArea; session: FakeArea }
}

/** Install a fresh `globalThis.chrome`. Call in `beforeEach`. */
export function installFakeChrome(): FakeChrome {
  const chrome: FakeChrome = { storage: { local: makeArea(), session: makeArea() } }
  ;(globalThis as unknown as { chrome: FakeChrome }).chrome = chrome
  return chrome
}

/**
 * Seed an unlocked session in the fake session area, so modules that derive
 * keys from the unlocked session can run — e.g. the encrypted note store
 * (#1646), whose key derives from the primary wallet's spend privkey. Any
 * 64-hex-char spend privkey works; it only has to be present.
 */
export async function seedUnlockedSession(
  chrome: FakeChrome,
  opts: { shieldedAddress?: string; spendPrivkeyHex?: string } = {}
): Promise<void> {
  await chrome.storage.session.set({
    paraloom_session: {
      wallet: {
        publicKey: "11".repeat(32),
        secretKey: "22".repeat(32),
        shieldedAddress: opts.shieldedAddress ?? "paraloom1" + "11".repeat(64),
        boxPublicKey: "33".repeat(32),
        boxSecretKey: "44".repeat(32),
        spendPrivkey: opts.spendPrivkeyHex ?? "55".repeat(32)
      },
      accounts: [],
      currentAccountIndex: 0,
      seedPhrase: null
    },
    paraloom_last_activity: Date.now()
  })
}
