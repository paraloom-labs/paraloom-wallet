import { beforeEach, describe, expect, it } from "vitest"

import {
  addApprovedOrigin,
  getApprovedOrigins,
  isOriginApproved,
  removeApprovedOrigin
} from "../lib/storage/connections"

const KEY = "paraloom_connections"
const ALPHA = "https://alpha.test"
const BETA = "https://beta.test"
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function installDelayedStorage(
  initial: string[],
  delayWrite: (next: string[]) => number = () => 0
) {
  let value = [...initial]
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        async get(key: string) {
          expect(key).toBe(KEY)
          const snapshot = structuredClone(value)
          await Promise.resolve()
          return { [KEY]: snapshot }
        },
        async set(values: Record<string, string[]>) {
          const next = structuredClone(values[KEY])
          await wait(delayWrite(next))
          value = next
        }
      }
    }
  }
  return { read: () => [...value] }
}

describe("connections storage concurrency", () => {
  beforeEach(() => {
    let previous: Promise<unknown> = Promise.resolve()
    Object.defineProperty(globalThis.navigator, "locks", {
      configurable: true,
      value: {
        request(_name: string, callback: () => Promise<unknown>) {
          const current = previous.then(callback, callback)
          previous = current.then(
            () => undefined,
            () => undefined
          )
          return current
        }
      }
    })
  })

  it("sequential revoke preserves the independently approved site", async () => {
    const store = installDelayedStorage([ALPHA, BETA])
    await removeApprovedOrigin(ALPHA)
    expect(store.read()).toEqual([BETA])
  })

  it("concurrent unrelated approval does not resurrect completed revocation", async () => {
    const store = installDelayedStorage([ALPHA], (next) =>
      next.includes(ALPHA) && next.includes(BETA) ? 30 : 0
    )
    await Promise.all([addApprovedOrigin(BETA), removeApprovedOrigin(ALPHA)])
    expect(await isOriginApproved(ALPHA)).toBe(false)
    expect(store.read()).toEqual([BETA])
  })

  it("concurrent revocations both remain effective", async () => {
    const store = installDelayedStorage([ALPHA, BETA], (next) =>
      next.length === 1 && next.includes(BETA) ? 30 : 0
    )
    await Promise.all([
      removeApprovedOrigin(ALPHA),
      removeApprovedOrigin(BETA)
    ])
    expect(store.read()).toEqual([])
  })

  it("concurrent approvals preserve both consent decisions", async () => {
    const store = installDelayedStorage([])
    await Promise.all([addApprovedOrigin(ALPHA), addApprovedOrigin(BETA)])
    expect(store.read().sort()).toEqual([ALPHA, BETA])
    expect(await getApprovedOrigins()).toEqual([ALPHA, BETA])
  })

  it("a rejected storage write releases the lock for the next mutation", async () => {
    const store = installDelayedStorage([])
    const write = chrome.storage.local.set
    let failOnce = true
    chrome.storage.local.set = async (values: Record<string, unknown>) => {
      if (failOnce) {
        failOnce = false
        throw new Error("synthetic storage failure")
      }
      return write(values)
    }
    await expect(addApprovedOrigin(ALPHA)).rejects.toThrow(
      /synthetic storage failure/
    )
    await addApprovedOrigin(BETA)
    expect(store.read()).toEqual([BETA])
  })
})
