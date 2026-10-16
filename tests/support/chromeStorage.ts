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

// One shared origin-wide lock manager, including independently imported module
// instances (popup and service worker). Model the exclusive request form used
// by the wallet, releasing the next waiter on both success and rejection.
function makeLocks() {
  const pending = new Map<string, Promise<void>>()
  return {
    async request<T>(name: string, callback: () => T | Promise<T>): Promise<T> {
      const previous = pending.get(name) ?? Promise.resolve()
      let release!: () => void
      const done = new Promise<void>((resolve) => {
        release = resolve
      })
      pending.set(name, done)
      await previous
      try {
        return await callback()
      } finally {
        release()
        if (pending.get(name) === done) pending.delete(name)
      }
    }
  }
}

/** Install a fresh `globalThis.chrome`. Call in `beforeEach`. */
export function installFakeChrome(): FakeChrome {
  const chrome: FakeChrome = { storage: { local: makeArea(), session: makeArea() } }
  ;(globalThis as unknown as { chrome: FakeChrome }).chrome = chrome
  // Node 20 has no navigator; newer Node versions expose a read-only one.
  // Keep this deterministic on both versions rather than depending on Node's
  // experimental Web Locks implementation.
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: makeLocks() }
  })
  return chrome
}
