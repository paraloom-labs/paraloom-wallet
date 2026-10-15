import { beforeEach, describe, expect, it } from "vitest"
import {
  addApprovedOrigin,
  connectWithRelay,
  disconnectOrigin,
  isOriginApproved,
  isOriginConnectionPending
} from "~lib/storage/connections"
import { installFakeChrome } from "./support/chromeStorage"

beforeEach(() => {
  installFakeChrome()
})

describe("DISCONNECT_WALLET persistence across MV3 worker restarts and multi-origin sessions", () => {
  it("revokes a persisted approved origin even when in-memory connectedOrigin is null after an MV3 restart", async () => {
    const origin = "https://app.paraloom.io"
    await addApprovedOrigin(origin)
    expect(await isOriginApproved(origin)).toBe(true)

    // Simulate MV3 service worker restart or auto-lock where `connectedOrigin` was reset to null
    const res = await disconnectOrigin(origin, null)
    expect(res.revoked).toBe(true)
    expect(res.nextConnectedOrigin).toBeNull()
    expect(await isOriginApproved(origin)).toBe(false)
  })

  it("revokes Origin A while preserving Origin B when Origin B is the current in-memory connectedOrigin", async () => {
    const originA = "https://app.paraloom.io"
    const originB = "https://swap.paraloom.io"
    await addApprovedOrigin(originA)
    await addApprovedOrigin(originB)

    // Origin A disconnects while `connectedOrigin` points to Origin B
    const res = await disconnectOrigin(originA, originB)
    expect(res.revoked).toBe(true)
    expect(res.nextConnectedOrigin).toBe(originB)
    expect(await isOriginApproved(originA)).toBe(false)
    expect(await isOriginApproved(originB)).toBe(true)
  })

  it("never allows an unapproved caller origin to affect another connected origin", async () => {
    const connected = "https://app.paraloom.io"
    const attacker = "https://other.paraloom.io"
    await addApprovedOrigin(connected)

    const res = await disconnectOrigin(attacker, connected)
    expect(res.revoked).toBe(false)
    expect(res.nextConnectedOrigin).toBe(connected)
    expect(await isOriginApproved(connected)).toBe(true)
  })
})

describe("connectWithRelay rejection propagation and MV3 recovery", () => {
  it("immediately rejects with 'Connection request rejected' when the user clicks Reject in ConnectApprove", async () => {
    let pollCount = 0
    const relay = async (type: string) => {
      if (type === "CONNECT_WALLET") {
        return { success: false, error: "Connection request rejected" }
      }
      if (type === "IS_CONNECTED") {
        pollCount++
        return { connected: false, locked: false, pending: false }
      }
      return null
    }

    await expect(connectWithRelay(relay, 5, 180)).rejects.toThrow(
      "Connection request rejected"
    )
    expect(pollCount).toBeLessThanOrEqual(2)
  })

  it("immediately surfaces 'No wallet found' instead of polling until the 126s timeout", async () => {
    const relay = async (type: string) => {
      if (type === "CONNECT_WALLET") {
        return { success: false, error: "No wallet found" }
      }
      if (type === "IS_CONNECTED") {
        return { connected: false, locked: false, pending: false }
      }
      return null
    }

    await expect(connectWithRelay(relay, 5, 180)).rejects.toThrow(
      "No wallet found"
    )
  })

  it("detects rejection after MV3 worker eviction when pendingConn is cleared without approval", async () => {
    await chrome.storage.session.set({
      pendingConn: { id: 101, origin: "https://app.paraloom.io" }
    })
    expect(await isOriginConnectionPending("https://app.paraloom.io")).toBe(true)

    let polls = 0
    const relay = async (type: string) => {
      if (type === "CONNECT_WALLET") {
        // Simulate MV3 worker eviction dropping the message port mid-approval
        throw new Error("The message port closed before a response was received.")
      }
      if (type === "IS_CONNECTED") {
        polls++
        if (polls >= 2) {
          // User clicked Reject in respawned worker -> pendingConn removed
          await chrome.storage.session.remove("pendingConn")
        }
        const pending = await isOriginConnectionPending("https://app.paraloom.io")
        return { connected: false, locked: false, pending }
      }
      return null
    }

    await expect(connectWithRelay(relay, 5, 180)).rejects.toThrow(
      "Connection request rejected"
    )
    expect(polls).toBeLessThanOrEqual(3)
  })

  it("waits for unlock when an already-approved origin connects while the wallet is locked", async () => {
    let polls = 0
    const relay = async (type: string) => {
      if (type === "CONNECT_WALLET") {
        // Simulate MV3 worker eviction while waiting for user to enter password
        throw new Error("The message port closed before a response was received.")
      }
      if (type === "IS_CONNECTED") {
        polls++
        // Polls 1-2: origin is approved (`connected: true`) but wallet is still locked
        return { connected: true, locked: polls < 3, pending: false }
      }
      if (type === "GET_ADDRESS") {
        return { address: "para1shieldedtestaddress" }
      }
      return null
    }

    const result = await connectWithRelay(relay, 5, 20)
    expect(polls).toBe(3)
    expect(result).toEqual({
      address: "para1shieldedtestaddress",
      publicKey: "para1shieldedtestaddress"
    })
  })
})
