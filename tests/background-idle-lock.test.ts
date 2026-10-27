import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installFakeChrome } from "./support/chromeStorage"

// Exercise the real message handler and idle alarm. All accounts and balances
// are synthetic; network and spending boundaries are forbidden in this test.
vi.mock("~lib/paraloom/scan", () => ({ scanForNotes: vi.fn(async () => 0) }))
vi.mock("~lib/paraloom/bridge", () => ({
  associatedTokenAddress: vi.fn(),
  depositSpl: vi.fn(),
  recoverReshieldedNote: vi.fn(),
  solanaAddress: vi.fn(() => "synthetic-public-address")
}))
vi.mock("~lib/paraloom/transact", () => ({ fetchV3Leaves: vi.fn() }))
vi.mock("~lib/paraloom/privateSwap", () => ({
  GAS_LAMPORTS: 1_000_000n,
  privateSwap: vi.fn(() => { throw new Error("spending forbidden in idle test") }),
  privateSwapFromToken: vi.fn(() => { throw new Error("spending forbidden in idle test") })
}))
vi.mock("~lib/paraloom/reshieldRecovery", () => ({
  persistReshieldedNote: vi.fn(),
  recoverReshields: vi.fn()
}))
vi.mock("~lib/paraloom/swapReconcile", () => ({ reconcileSwapOutputs: vi.fn() }))
vi.mock("~lib/prover", () => ({
  assetIdForMint: vi.fn(),
  NATIVE_ASSET_HEX: "00".repeat(32)
}))

const START = Date.parse("2026-10-01T00:00:00Z")
const ORIGIN = "https://example.paraloom.io"
const ACCOUNT = "synthetic-idle-test-account"
const SITE = { origin: ORIGIN, url: `${ORIGIN}/app`, tab: { id: 1, url: `${ORIGIN}/app` } }
const POPUP = { url: "chrome-extension://synthetic-extension/popup.html" }
type Listener = (message: any, sender: any, reply: (value: any) => void) => boolean
let onMessage: Listener
let onAlarm: (alarm: { name: string }) => void
let chrome: ReturnType<typeof installFakeChrome> & {
  runtime: any
  alarms: any
  windows: any
}

async function drain() {
  // Storage operations and the production listener intentionally use detached
  // promises. Flush those microtasks without advancing any timers.
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

async function send(message: any, sender: any = SITE): Promise<any> {
  const response = await new Promise((resolve) => onMessage(message, sender, resolve))
  await drain()
  return response
}

async function idleAlarmAt(milliseconds: number) {
  vi.setSystemTime(START + milliseconds)
  onAlarm({ name: "paraloom-auto-lock" })
  await drain()
}

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(START)
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden in idle test") }))
  chrome = installFakeChrome() as typeof chrome
  chrome.runtime = {
    getURL: (path: string) => `chrome-extension://synthetic-extension/${path}`,
    getPlatformInfo: vi.fn(async () => ({})),
    onMessage: { addListener: (listener: Listener) => { onMessage = listener } }
  }
  chrome.alarms = {
    create: vi.fn(),
    onAlarm: { addListener: (listener: typeof onAlarm) => { onAlarm = listener } }
  }
  chrome.windows = {
    getLastFocused: vi.fn(async () => ({ left: 0, top: 0, width: 1000 })),
    create: vi.fn(async () => ({}))
  }
  await chrome.storage.local.set({
    paraloom_wallet: {
      wallet: { address: ACCOUNT, encryptedData: {} },
      locked: false,
      autoLockMinutes: 1
    },
    paraloom_connections: [ORIGIN]
  })
  const { saveSession } = await import("~lib/storage/session")
  await saveSession({
    wallet: {
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(64),
      shieldedAddress: ACCOUNT,
      boxPublicKey: new Uint8Array(32),
      boxSecretKey: new Uint8Array(32),
      spendPrivkey: new Uint8Array(32)
    },
    accounts: [],
    currentAccountIndex: 0,
    seedPhrase: null
  })
  const { addNote } = await import("~lib/paraloom/notes")
  await addNote(ACCOUNT, {
    amount: "12345", blinding: "00".repeat(32), assetId: "00".repeat(32),
    signature: "synthetic-deposit", createdAt: START, spent: false
  })
  await import("../src/background/index")
  await drain()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("site requests must not count as a wallet owner interaction", () => {
  it("locks an otherwise idle session after its configured minute", async () => {
    await idleAlarmAt(61_000)
    expect(await send({ type: "GET_SHIELDED_BALANCE" })).toEqual({ lamports: null })
    expect((await chrome.storage.local.get("paraloom_wallet")).paraloom_wallet).toMatchObject({ locked: true })
  })

  it("still locks after an approved site sends a malformed swap, without opening a popup", async () => {
    vi.setSystemTime(START + 50_000)
    await send({ type: "PRIVATE_SWAP", params: {} })
    expect((await chrome.storage.session.get("swapJob")).swapJob).toMatchObject({
      status: "error", error: "invalid params"
    })
    expect(chrome.windows.create).not.toHaveBeenCalled()

    await idleAlarmAt(61_000)
    expect(await send({ type: "GET_SHIELDED_BALANCE" })).toEqual({ lamports: null })
  })

  it("still locks after an already-approved site reconnects silently", async () => {
    vi.setSystemTime(START + 50_000)
    expect(await send({ type: "CONNECT_WALLET" })).toMatchObject({ success: true })
    expect(chrome.windows.create).not.toHaveBeenCalled()

    await idleAlarmAt(61_000)
    expect(await send({ type: "GET_SHIELDED_BALANCE" })).toEqual({ lamports: null })
  })

  it("does not grant an in-flight spending exemption before the owner approves", async () => {
    vi.setSystemTime(START + 50_000)
    await send({ type: "PRIVATE_SWAP", params: { outputMint: "synthetic", amountLamports: "1" } })
    expect(chrome.windows.create).toHaveBeenCalledOnce()
    expect(await send({ type: "GET_PENDING_SWAP" }, POPUP)).toMatchObject({ origin: ORIGIN })
    await idleAlarmAt(61_000)
    expect(await send({ type: "GET_SHIELDED_BALANCE" })).toEqual({ lamports: null })
  })

  it("retains the bounded lock exemption for an actually approved in-flight job", async () => {
    await chrome.storage.session.set({
      swapJob: { status: "pending", approved: true, startedAt: START }
    })
    await idleAlarmAt(61_000)
    expect(await send({ type: "GET_SHIELDED_BALANCE" })).toEqual({ lamports: "12345" })
    await idleAlarmAt(481_000)
    expect(await send({ type: "GET_SHIELDED_BALANCE" })).toEqual({ lamports: null })
  })

  it("counts a new connection's explicit popup approval as owner activity", async () => {
    vi.setSystemTime(START + 50_000)
    const newSite = { origin: "https://new.paraloom.io", tab: { id: 3 } }
    const connecting = send({ type: "CONNECT_WALLET" }, newSite)
    await drain()
    const pending = await send({ type: "GET_PENDING_CONNECTION" }, POPUP)
    expect(pending.origin).toBe(newSite.origin)
    await send({ type: "APPROVE_CONNECTION", id: pending.id }, POPUP)
    expect(await connecting).toMatchObject({ success: true })
    await idleAlarmAt(61_000)
    expect(await send({ type: "GET_SHIELDED_BALANCE" }, newSite)).toEqual({ lamports: "12345" })
    await idleAlarmAt(111_000)
    expect(await send({ type: "GET_SHIELDED_BALANCE" }, newSite)).toEqual({ lamports: null })
  })

  it("rejects an unapproved site's request and keeps the original idle deadline", async () => {
    vi.setSystemTime(START + 50_000)
    const stranger = { origin: "https://unapproved.paraloom.io", tab: { id: 2 } }
    expect(await send({ type: "PRIVATE_SWAP", params: {} }, stranger)).toMatchObject({
      success: false, error: "not authorized"
    })
    await idleAlarmAt(61_000)
    expect(await send({ type: "GET_SHIELDED_BALANCE" })).toEqual({ lamports: null })
  })

  it("honors a real popup interaction by starting a fresh idle interval", async () => {
    vi.setSystemTime(START + 50_000)
    expect(await send({ type: "ACTIVITY" }, POPUP)).toEqual({ success: true })
    await idleAlarmAt(61_000)
    expect(await send({ type: "GET_SHIELDED_BALANCE" })).toEqual({ lamports: "12345" })
    await idleAlarmAt(111_000)
    expect(await send({ type: "GET_SHIELDED_BALANCE" })).toEqual({ lamports: null })
  })
})
