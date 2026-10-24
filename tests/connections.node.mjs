import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

// Only an in-memory fake Chrome storage area and reserved .test origins are
// used. No browser, network, wallet material, or protocol transaction is used.
const filename =
  process.env.CONNECTIONS_SOURCE ??
  fileURLToPath(new URL("../lib/storage/connections.ts", import.meta.url))
const source = pathToFileURL(filename).href
const KEY = "paraloom_connections"
const ALPHA = "https://alpha.test"
const BETA = "https://beta.test"
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Separate imported modules model popup and service-worker JS contexts while
// sharing one storage area and one origin-wide browser lock manager.
let previous = Promise.resolve()
Object.defineProperty(globalThis.navigator, "locks", {
  configurable: true,
  value: {
    request(_name, callback) {
      const current = previous.then(callback, callback)
      previous = current.then(
        () => undefined,
        () => undefined
      )
      return current
    }
  }
})

function installStorage(initial, delayWrite = () => 0) {
  let value = [...initial]
  const events = []
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          assert.equal(key, KEY)
          const snapshot = structuredClone(value)
          events.push(["read", structuredClone(snapshot)])
          await Promise.resolve()
          return { [KEY]: snapshot }
        },
        async set(values) {
          const next = structuredClone(values[KEY])
          await wait(delayWrite(next))
          value = next
          events.push(["write", [...value]])
        }
      }
    }
  }
  return { read: () => [...value], events }
}

const popup = await import(`${source}?context=popup`)
const background = await import(`${source}?context=background`)

test("sequential revoke preserves the independently approved site", async () => {
  const store = installStorage([ALPHA, BETA])
  await popup.removeApprovedOrigin(ALPHA)
  assert.deepEqual(store.read(), [BETA])
})

test("concurrent unrelated approval must not resurrect completed revocation", async () => {
  const store = installStorage([ALPHA], (next) =>
    next.includes(ALPHA) && next.includes(BETA) ? 30 : 0
  )
  await Promise.all([
    background.addApprovedOrigin(BETA),
    popup.removeApprovedOrigin(ALPHA)
  ])
  const approved = await popup.isOriginApproved(ALPHA)
  assert.equal(
    approved,
    false,
    "the completed alpha revocation must remain effective"
  )
  assert.deepEqual(store.read(), [BETA])
})

test("concurrent revocations must both remain effective", async () => {
  const store = installStorage([ALPHA, BETA], (next) =>
    next.length === 1 && next.includes(BETA) ? 30 : 0
  )
  await Promise.all([
    popup.removeApprovedOrigin(ALPHA),
    background.removeApprovedOrigin(BETA)
  ])
  assert.deepEqual(store.read(), [])
})

test("concurrent approvals preserve both consent decisions", async () => {
  const store = installStorage([])
  await Promise.all([
    popup.addApprovedOrigin(ALPHA),
    background.addApprovedOrigin(BETA)
  ])
  assert.deepEqual(store.read().sort(), [ALPHA, BETA])
})

test("a rejected storage write releases the lock for the next mutation", async () => {
  const store = installStorage([])
  const write = chrome.storage.local.set
  let failOnce = true
  chrome.storage.local.set = async (values) => {
    if (failOnce) {
      failOnce = false
      throw new Error("synthetic storage failure")
    }
    return write(values)
  }
  await assert.rejects(
    popup.addApprovedOrigin(ALPHA),
    /synthetic storage failure/
  )
  await background.addApprovedOrigin(BETA)
  assert.deepEqual(store.read(), [BETA])
})
