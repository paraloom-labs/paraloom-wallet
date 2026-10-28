import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installFakeChrome } from "./support/chromeStorage"

vi.mock("~lib/paraloom/scan", () => ({ scanForNotes: vi.fn(async () => 0) }))
vi.mock("~lib/paraloom/bridge", () => ({
  associatedTokenAddress: vi.fn(),
  depositSpl: vi.fn(),
  recoverReshieldedNote: vi.fn(),
  claimWithdrawal: vi.fn()
}))

describe("Superseded connection requests and keep-alive settlement (#1029)", () => {
  let fakeChrome: ReturnType<typeof installFakeChrome>

  beforeEach(async () => {
    vi.useFakeTimers()
    fakeChrome = installFakeChrome()
    // Populate fake wallet so handleConnect proceeds to requestApproval
    await chrome.storage.local.set({
      encryptedWallet: { data: "test", iv: "test", salt: "test" }
    })
    await import("../src/background/index")
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    fakeChrome.uninstall()
  })

  it("settles superseded connection request when a second request arrives", async () => {
    const site1 = { origin: "https://tab1.paraloom.io", tab: { id: 1 } }
    const site2 = { origin: "https://tab2.paraloom.io", tab: { id: 2 } }

    const send = (msg: any, sender: any) =>
      new Promise<any>((resolve) => {
        chrome.runtime.onMessage.dispatch(msg, sender, resolve)
      })

    // First connection attempt
    const req1Promise = send({ type: "CONNECT_WALLET" }, site1)

    // Second connection attempt from another tab / double click
    const req2Promise = send({ type: "CONNECT_WALLET" }, site2)

    // Request 1 should cleanly settle (reject / resolve false) rather than hanging indefinitely
    const res1 = await req1Promise
    expect(res1).toMatchObject({ success: false })

    // Verify session storage keeps the second connection request
    const stored = await chrome.storage.session.get("pendingConn")
    expect(stored.pendingConn).toBeDefined()
    expect(stored.pendingConn.origin).toBe(site2.origin)
  })

  it("does not clear newer pendingConn when rejecting an older superseded request", async () => {
    const site = { origin: "https://dapp.paraloom.io", tab: { id: 10 } }
    const send = (msg: any, sender: any) =>
      new Promise<any>((resolve) => {
        chrome.runtime.onMessage.dispatch(msg, sender, resolve)
      })

    // First request
    void send({ type: "CONNECT_WALLET" }, site)
    // Second request
    void send({ type: "CONNECT_WALLET" }, site)

    const storedBefore = await chrome.storage.session.get("pendingConn")
    const currentId = storedBefore.pendingConn.id

    // Attempt to reject with an outdated ID (e.g. ID - 1)
    const popupSender = {}
    await send({ type: "REJECT_CONNECTION", id: currentId - 1 }, popupSender)

    // Current pendingConn must remain intact in storage
    const storedAfter = await chrome.storage.session.get("pendingConn")
    expect(storedAfter.pendingConn).toBeDefined()
    expect(storedAfter.pendingConn.id).toBe(currentId)
  })
})
