import {
  addApprovedOrigin,
  getApprovedOrigins,
  isOriginApproved,
  removeApprovedOrigin
} from "~lib/storage/connections"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { installFakeChrome } from "./support/chromeStorage"

const ALPHA = "https://alpha.test"
const BETA = "https://beta.test"
const GAMMA = "https://gamma.test"

function setupMockNavigatorLocks() {
  let lockPromise = Promise.resolve()

  const originalNavigator = globalThis.navigator
  const mockNavigator = {
    ...originalNavigator,
    locks: {
      async request(
        name: string,
        callback: (lock?: unknown) => Promise<unknown> | unknown
      ) {
        const next = lockPromise.then(async () => {
          return await callback()
        })
        lockPromise = next.then(
          () => undefined,
          () => undefined
        )
        return next
      }
    }
  }

  Object.defineProperty(globalThis, "navigator", {
    value: mockNavigator,
    configurable: true,
    writable: true
  })

  return () => {
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
      writable: true
    })
  }
}

describe("connections storage with Web Locks (#983)", () => {
  let restoreNavigator: () => void

  beforeEach(() => {
    installFakeChrome()
    restoreNavigator = setupMockNavigatorLocks()
  })

  afterEach(() => {
    restoreNavigator()
  })

  it("handles sequential add and remove operations correctly", async () => {
    expect(await getApprovedOrigins()).toEqual([])
    expect(await isOriginApproved(ALPHA)).toBe(false)

    await addApprovedOrigin(ALPHA)
    expect(await getApprovedOrigins()).toEqual([ALPHA])
    expect(await isOriginApproved(ALPHA)).toBe(true)

    await addApprovedOrigin(BETA)
    expect((await getApprovedOrigins()).sort()).toEqual([ALPHA, BETA].sort())

    await removeApprovedOrigin(ALPHA)
    expect(await getApprovedOrigins()).toEqual([BETA])
    expect(await isOriginApproved(ALPHA)).toBe(false)
    expect(await isOriginApproved(BETA)).toBe(true)
  })

  it("is idempotent: duplicate add does not duplicate origin", async () => {
    await addApprovedOrigin(ALPHA)
    await addApprovedOrigin(ALPHA)
    expect(await getApprovedOrigins()).toEqual([ALPHA])
  })

  it("concurrent add operations preserve both origins without clobbering", async () => {
    await Promise.all([
      addApprovedOrigin(ALPHA),
      addApprovedOrigin(BETA),
      addApprovedOrigin(GAMMA)
    ])

    const origins = await getApprovedOrigins()
    expect(origins.sort()).toEqual([ALPHA, BETA, GAMMA].sort())
    expect(await isOriginApproved(ALPHA)).toBe(true)
    expect(await isOriginApproved(BETA)).toBe(true)
    expect(await isOriginApproved(GAMMA)).toBe(true)
  })

  it("concurrent revocation and approval does not resurrect revoked origin (#983 regression)", async () => {
    // Seed initial state with ALPHA
    await addApprovedOrigin(ALPHA)
    expect(await isOriginApproved(ALPHA)).toBe(true)

    // Concurrently remove ALPHA (from popup) and add BETA (from background)
    await Promise.all([
      removeApprovedOrigin(ALPHA),
      addApprovedOrigin(BETA)
    ])

    const origins = await getApprovedOrigins()
    expect(origins).toEqual([BETA])
    expect(await isOriginApproved(ALPHA)).toBe(false)
    expect(await isOriginApproved(BETA)).toBe(true)
  })

  it("concurrent multiple revocations both take effect", async () => {
    await addApprovedOrigin(ALPHA)
    await addApprovedOrigin(BETA)
    await addApprovedOrigin(GAMMA)

    await Promise.all([
      removeApprovedOrigin(ALPHA),
      removeApprovedOrigin(BETA)
    ])

    expect(await getApprovedOrigins()).toEqual([GAMMA])
    expect(await isOriginApproved(ALPHA)).toBe(false)
    expect(await isOriginApproved(BETA)).toBe(false)
    expect(await isOriginApproved(GAMMA)).toBe(true)
  })

  it("releases lock properly even if an error is thrown inside", async () => {
    const originalSet = chrome.storage.local.set
    let shouldFail = true
    chrome.storage.local.set = async (items: Record<string, unknown>) => {
      if (shouldFail) {
        shouldFail = false
        throw new Error("Simulated storage write error")
      }
      return originalSet(items)
    }

    await expect(addApprovedOrigin(ALPHA)).rejects.toThrow("Simulated storage write error")

    // The lock must have been released so that subsequent operation proceeds
    await addApprovedOrigin(BETA)
    expect(await getApprovedOrigins()).toEqual([BETA])
  })

  it("falls back gracefully when navigator.locks is unavailable", async () => {
    // Remove navigator.locks
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      configurable: true,
      writable: true
    })

    await addApprovedOrigin(ALPHA)
    expect(await isOriginApproved(ALPHA)).toBe(true)
    await removeApprovedOrigin(ALPHA)
    expect(await isOriginApproved(ALPHA)).toBe(false)
  })
})
