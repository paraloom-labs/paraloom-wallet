import { beforeEach, describe, expect, it } from "vitest"
import { getApprovedOrigins, isOriginApproved } from "../lib/storage/connections"
import {
  approvePendingConnection,
  cleanStalePendingConnection,
  DEFAULT_CONNECTION_TIMEOUT_MS,
  getPendingConnection,
  PENDING_CONN_KEY,
  recordPendingConnection,
  rejectPendingConnection
} from "../lib/storage/pendingConnection"
import { installFakeChrome, type FakeChrome } from "./support/chromeStorage"

describe("pendingConnection", () => {
  let fakeChrome: FakeChrome

  beforeEach(() => {
    fakeChrome = installFakeChrome()
  })

  describe("recordPendingConnection", () => {
    it("persists pending connection with id, origin and expiresAt", async () => {
      const start = 1_000_000
      await recordPendingConnection(42, "https://dapp.example.com", 60_000, start)

      const stored = fakeChrome.storage.session.raw[PENDING_CONN_KEY] as Record<string, unknown>
      expect(stored).toEqual({
        id: 42,
        origin: "https://dapp.example.com",
        expiresAt: 1_060_000
      })
    })

    it("uses default 120s timeout if timeoutMs is omitted", async () => {
      const start = 2_000_000
      await recordPendingConnection(1, "https://test.io", undefined, start)

      const stored = fakeChrome.storage.session.raw[PENDING_CONN_KEY] as Record<string, unknown>
      expect(stored.expiresAt).toBe(start + DEFAULT_CONNECTION_TIMEOUT_MS)
    })
  })

  describe("getPendingConnection", () => {
    it("returns null when no pending connection exists", async () => {
      const result = await getPendingConnection()
      expect(result).toBeNull()
    })

    it("returns pending connection when unexpired", async () => {
      const start = 1_000_000
      await recordPendingConnection(10, "https://dapp.xyz", 60_000, start)

      // Query before expiration
      const result = await getPendingConnection(start + 30_000)
      expect(result).toEqual({ id: 10, origin: "https://dapp.xyz" })
    })

    it("returns null and clears storage when expired (surviving service-worker eviction)", async () => {
      const start = 1_000_000
      await recordPendingConnection(10, "https://dapp.xyz", 60_000, start)

      // Query after expiration
      const result = await getPendingConnection(start + 60_001)
      expect(result).toBeNull()

      // Confirm it was removed from storage
      expect(fakeChrome.storage.session.raw[PENDING_CONN_KEY]).toBeUndefined()
    })
  })

  describe("approvePendingConnection", () => {
    it("returns error when no pending connection exists", async () => {
      const res = await approvePendingConnection(1)
      expect(res).toEqual({ success: false, error: "no pending connection" })
    })

    it("returns error when connection id does not match", async () => {
      const start = 1_000_000
      await recordPendingConnection(10, "https://dapp.xyz", 60_000, start)

      const res = await approvePendingConnection(99, start + 10_000)
      expect(res).toEqual({ success: false, error: "invalid connection id" })

      // Does not approve the origin
      expect(await isOriginApproved("https://dapp.xyz")).toBe(false)
      // Storage remains intact for the valid pending connection
      expect(fakeChrome.storage.session.raw[PENDING_CONN_KEY]).toBeDefined()
    })

    it("rejects approval and clears storage when expired after worker eviction", async () => {
      const start = 1_000_000
      await recordPendingConnection(10, "https://dapp.xyz", 60_000, start)

      // Approval attempted after expiration
      const res = await approvePendingConnection(10, start + 65_000)
      expect(res).toEqual({ success: false, error: "connection request expired" })

      // Origin must NOT be approved
      expect(await isOriginApproved("https://dapp.xyz")).toBe(false)
      // Storage must be cleared
      expect(fakeChrome.storage.session.raw[PENDING_CONN_KEY]).toBeUndefined()
    })

    it("successfully approves matching unexpired request and adds to approved origins", async () => {
      const start = 1_000_000
      await recordPendingConnection(10, "https://dapp.xyz", 60_000, start)

      const res = await approvePendingConnection(10, start + 10_000)
      expect(res).toEqual({ success: true, origin: "https://dapp.xyz" })

      // Origin must be approved in persistent local storage
      expect(await isOriginApproved("https://dapp.xyz")).toBe(true)
      expect(await getApprovedOrigins()).toContain("https://dapp.xyz")

      // Pending connection must be cleared from session storage
      expect(fakeChrome.storage.session.raw[PENDING_CONN_KEY]).toBeUndefined()
    })
  })

  describe("rejectPendingConnection", () => {
    it("clears pending connection when id matches", async () => {
      await recordPendingConnection(7, "https://dapp.xyz", 60_000)
      await rejectPendingConnection(7)
      expect(fakeChrome.storage.session.raw[PENDING_CONN_KEY]).toBeUndefined()
    })

    it("does not clear pending connection if id does not match", async () => {
      await recordPendingConnection(7, "https://dapp.xyz", 60_000)
      await rejectPendingConnection(8)
      expect(fakeChrome.storage.session.raw[PENDING_CONN_KEY]).toBeDefined()
    })
  })

  describe("cleanStalePendingConnection", () => {
    it("cleans up expired connection and returns true", async () => {
      const start = 1_000_000
      await recordPendingConnection(1, "https://stale.io", 30_000, start)

      const cleaned = await cleanStalePendingConnection(start + 40_000)
      expect(cleaned).toBe(true)
      expect(fakeChrome.storage.session.raw[PENDING_CONN_KEY]).toBeUndefined()
    })

    it("leaves fresh connection alone and returns false", async () => {
      const start = 1_000_000
      await recordPendingConnection(1, "https://fresh.io", 30_000, start)

      const cleaned = await cleanStalePendingConnection(start + 10_000)
      expect(cleaned).toBe(false)
      expect(fakeChrome.storage.session.raw[PENDING_CONN_KEY]).toBeDefined()
    })
  })

  describe("service worker eviction scenarios", () => {
    it("prevents stale approval from succeeding after eviction when timeout has elapsed", async () => {
      // 1. Dapp initiates connection in original worker
      const initTime = 10_000_000
      await recordPendingConnection(101, "https://app.paraloom.io", 120_000, initTime)

      // 2. Service worker is evicted at initTime + 30s (timer destroyed, in-memory state lost)
      // Time advances past the 120s timeout window:
      const wakeTime = initTime + 150_000 // 150 seconds later

      // 3. Service worker respawns. cleanStalePendingConnection runs on startup/alarm:
      await cleanStalePendingConnection(wakeTime)

      // 4. Stale request is gone:
      expect(await getPendingConnection(wakeTime)).toBeNull()

      // 5. If APPROVE_CONNECTION arrives, it fails and does not approve:
      const approveRes = await approvePendingConnection(101, wakeTime)
      expect(approveRes.success).toBe(false)
      expect(await isOriginApproved("https://app.paraloom.io")).toBe(false)
    })

    it("allows approval to succeed after worker eviction if still within timeout window", async () => {
      // 1. Dapp initiates connection
      const initTime = 10_000_000
      await recordPendingConnection(102, "https://app.paraloom.io", 120_000, initTime)

      // 2. Worker is evicted and respawns at 40s (within 120s window)
      const wakeTime = initTime + 40_000

      // 3. Popup retrieves pending connection:
      const pending = await getPendingConnection(wakeTime)
      expect(pending).toEqual({ id: 102, origin: "https://app.paraloom.io" })

      // 4. User approves in popup:
      const approveRes = await approvePendingConnection(102, wakeTime + 5000)
      expect(approveRes).toEqual({ success: true, origin: "https://app.paraloom.io" })
      expect(await isOriginApproved("https://app.paraloom.io")).toBe(true)
    })
  })
})
