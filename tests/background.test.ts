import { beforeEach, describe, expect, it, vi } from "vitest"
import { installFakeChrome, type FakeChrome } from "./support/chromeStorage"

vi.mock("~lib/prover", () => ({
  assetIdForMint: vi.fn(),
  NATIVE_ASSET_HEX: "00".repeat(32)
}))

import {
  handleConnect,
  requestApproval,
  requestSwapApproval,
  senderOrigin
} from "../src/background/index"

describe("background service worker guards (#264)", () => {
  let fakeChrome: FakeChrome

  beforeEach(() => {
    fakeChrome = installFakeChrome()
  })

  describe("senderOrigin", () => {
    it("rejects opaque null origins and sandboxed iframes", () => {
      expect(senderOrigin({ origin: "null" } as any)).toBeNull()
      expect(
        senderOrigin({ origin: "null", tab: { url: "https://example.com" } } as any)
      ).toBeNull()
      expect(
        senderOrigin({ tab: { url: "data:text/html,<html></html>" } } as any)
      ).toBeNull()
    })

    it("handles malformed tab URLs gracefully without throwing", () => {
      expect(senderOrigin({ tab: { url: "not a valid url" } } as any)).toBeNull()
      expect(senderOrigin({ tab: { url: "://missing-scheme" } } as any)).toBeNull()
      expect(senderOrigin({} as any)).toBeNull()
      expect(senderOrigin(undefined as any)).toBeNull()
    })

    it("rejects non-HTTP/HTTPS schemes", () => {
      expect(
        senderOrigin({ tab: { url: "chrome-extension://some-ext/popup.html" } } as any)
      ).toBeNull()
      expect(
        senderOrigin({ origin: "chrome-extension://some-ext" } as any)
      ).toBeNull()
      expect(senderOrigin({ tab: { url: "javascript:alert(1)" } } as any)).toBeNull()
      expect(senderOrigin({ tab: { url: "file:///etc/passwd" } } as any)).toBeNull()
    })

    it("accepts valid HTTP and HTTPS origins", () => {
      expect(senderOrigin({ origin: "https://app.paraloom.io" } as any)).toBe(
        "https://app.paraloom.io"
      )
      expect(senderOrigin({ origin: "http://localhost:3000" } as any)).toBe(
        "http://localhost:3000"
      )
      expect(
        senderOrigin({
          tab: { url: "https://paraloom.io/swap?referrer=xyz" }
        } as any)
      ).toBe("https://paraloom.io")
    })
  })

  describe("handleConnect origin rejection", () => {
    it("rejects sandboxed 'null' origin or malformed URLs", async () => {
      await expect(
        handleConnect({ origin: "null" } as any)
      ).rejects.toThrow("Unable to determine the requesting site's origin")

      await expect(
        handleConnect({ tab: { url: "malformed:url" } } as any)
      ).rejects.toThrow("Unable to determine the requesting site's origin")
    })
  })

  describe("onMessage listener malformed message guards", () => {
    it("does not crash on non-object messages (null, undefined, primitive)", () => {
      const listener = fakeChrome.runtime.onMessage.listeners[0]
      expect(listener).toBeDefined()

      const sendResponse = vi.fn()
      expect(listener(null, {} as any, sendResponse)).toBe(false)
      expect(listener(undefined, {} as any, sendResponse)).toBe(false)
      expect(listener("string-msg", {} as any, sendResponse)).toBe(false)
      expect(listener(12345, {} as any, sendResponse)).toBe(false)
      expect(sendResponse).not.toHaveBeenCalled()
    })
  })

  describe("superseded request cancellation", () => {
    it("resolves superseded requestApproval with false and clears timer", async () => {
      const p1 = requestApproval("https://site-a.com", 60_000)
      const p2 = requestApproval("https://site-b.com", 60_000)

      // p1 should immediately settle with false (superseded)
      const r1 = await p1
      expect(r1).toBe(false)

      // Storage should hold the active request (site-b)
      const stored = await fakeChrome.storage.session.get("pendingConn")
      expect(stored.pendingConn).toMatchObject({ origin: "https://site-b.com" })

      // Settle p2
      const listener = fakeChrome.runtime.onMessage.listeners[0]
      listener(
        { type: "REJECT_CONNECTION", id: (stored.pendingConn as any).id },
        { url: "chrome-extension://mock-id/popup.html" } as any,
        vi.fn()
      )
      const r2 = await p2
      expect(r2).toBe(false)
    })

    it("resolves superseded requestSwapApproval with false and clears timer", async () => {
      const swapParams = {
        outputMint: "SOL",
        amountLamports: "1000000"
      }
      const p1 = requestSwapApproval("https://site-a.com", swapParams, 60_000)
      const p2 = requestSwapApproval("https://site-b.com", swapParams, 60_000)

      // p1 should immediately settle with false (superseded)
      const r1 = await p1
      expect(r1).toBe(false)

      // Settle p2 via APPROVE_SWAP
      const listener = fakeChrome.runtime.onMessage.listeners[0]
      const getPendingSwapResponse = vi.fn()
      listener(
        { type: "GET_PENDING_SWAP" },
        { url: "chrome-extension://mock-id/popup.html" } as any,
        getPendingSwapResponse
      )
      expect(getPendingSwapResponse).toHaveBeenCalledWith(
        expect.objectContaining({ origin: "https://site-b.com" })
      )

      const activeSwapId = getPendingSwapResponse.mock.calls[0][0].id
      listener(
        { type: "APPROVE_SWAP", id: activeSwapId },
        { url: "chrome-extension://mock-id/popup.html" } as any,
        vi.fn()
      )
      const r2 = await p2
      expect(r2).toBe(true)
    })
  })
})
