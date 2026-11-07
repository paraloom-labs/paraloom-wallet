import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  isFromPopup,
  onMessageListener,
  requestSwapApproval,
  senderOrigin
} from "../src/background/index"
import { installFakeChrome } from "./support/chromeStorage"

vi.mock("~lib/prover", () => ({
  assetIdForMint: vi.fn(async () => "00".repeat(32)),
  NATIVE_ASSET_HEX: "00".repeat(32)
}))

describe("background helper functions", () => {
  beforeEach(() => {
    installFakeChrome()
  })

  describe("isFromPopup", () => {
    it("returns false for undefined or malformed sender", () => {
      expect(isFromPopup(undefined as unknown as chrome.runtime.MessageSender)).toBe(false)
      expect(isFromPopup({} as unknown as chrome.runtime.MessageSender)).toBe(false)
      expect(
        isFromPopup({ url: "https://example.com" } as unknown as chrome.runtime.MessageSender)
      ).toBe(false)
    })

    it("returns true for extension pages", () => {
      expect(
        isFromPopup({
          url: "chrome-extension://fakeid/popup.html"
        } as unknown as chrome.runtime.MessageSender)
      ).toBe(true)
    })
  })

  describe("senderOrigin", () => {
    it("returns null for null, undefined or empty sender", () => {
      expect(senderOrigin(null as unknown as chrome.runtime.MessageSender)).toBeNull()
      expect(senderOrigin(undefined as unknown as chrome.runtime.MessageSender)).toBeNull()
      expect(senderOrigin({} as unknown as chrome.runtime.MessageSender)).toBeNull()
    })

    it("returns null for opaque origin string 'null'", () => {
      expect(
        senderOrigin({
          origin: "null"
        } as unknown as chrome.runtime.MessageSender)
      ).toBeNull()
    })

    it("returns sender.origin when valid and not 'null'", () => {
      expect(
        senderOrigin({
          origin: "https://app.paraloom.io"
        } as unknown as chrome.runtime.MessageSender)
      ).toBe("https://app.paraloom.io")
    })

    it("parses sender.tab.url or sender.url fallback", () => {
      expect(
        senderOrigin({
          tab: { url: "https://dapp.example.com/swap?ref=1" }
        } as unknown as chrome.runtime.MessageSender)
      ).toBe("https://dapp.example.com")

      expect(
        senderOrigin({
          url: "https://sub.dapp.com:8080/path"
        } as unknown as chrome.runtime.MessageSender)
      ).toBe("https://sub.dapp.com:8080")
    })

    it("returns null for malformed or opaque URLs in tab.url", () => {
      expect(
        senderOrigin({
          tab: { url: "invalid-url-string" }
        } as unknown as chrome.runtime.MessageSender)
      ).toBeNull()

      expect(
        senderOrigin({
          tab: { url: "data:text/html,<html></html>" }
        } as unknown as chrome.runtime.MessageSender)
      ).toBeNull()
    })
  })

  describe("onMessageListener", () => {
    it("rejects malformed messages", () => {
      const sendResponse = vi.fn()
      const ret1 = onMessageListener(null, {} as any, sendResponse)
      expect(ret1).toBe(false)
      expect(sendResponse).toHaveBeenCalledWith({ success: false, error: "invalid message" })

      sendResponse.mockClear()
      const ret2 = onMessageListener({ foo: "bar" }, {} as any, sendResponse)
      expect(ret2).toBe(false)
      expect(sendResponse).toHaveBeenCalledWith({ success: false, error: "invalid message" })
    })

    it("rejects popup-only messages from non-popup senders", () => {
      const sendResponse = vi.fn()
      const sender = { url: "https://attacker.com" } as chrome.runtime.MessageSender
      const ret = onMessageListener({ type: "APPROVE_SWAP", id: 1 }, sender, sendResponse)
      expect(ret).toBe(false)
      expect(sendResponse).toHaveBeenCalledWith({ success: false, error: "not permitted" })
    })

    it("handles APPROVE_SWAP and REJECT_SWAP safely when id is not a number", () => {
      const sendResponse = vi.fn()
      const sender = {
        url: "chrome-extension://fakeid/popup.html"
      } as chrome.runtime.MessageSender

      const retApprove = onMessageListener(
        { type: "APPROVE_SWAP", id: "not-a-number" },
        sender,
        sendResponse
      )
      expect(retApprove).toBe(false)
      expect(sendResponse).toHaveBeenCalledWith({ success: true })

      sendResponse.mockClear()
      const retReject = onMessageListener({ type: "REJECT_SWAP", id: null }, sender, sendResponse)
      expect(retReject).toBe(false)
      expect(sendResponse).toHaveBeenCalledWith({ success: true })
    })
  })

  describe("requestSwapApproval", () => {
    it("resolves superseded pending swap immediately with false", async () => {
      const swap1Promise = requestSwapApproval(
        "https://origin1.com",
        { outputMint: "SOL", amountLamports: "1000" } as any,
        60_000
      )

      // Initiating second swap approval request supersedes swap1
      const swap2Promise = requestSwapApproval(
        "https://origin2.com",
        { outputMint: "WSOL", amountLamports: "2000" } as any,
        60_000
      )

      // swap1 must have immediately resolved to false
      const swap1Result = await swap1Promise
      expect(swap1Result).toBe(false)

      // Now approve swap2
      const sendResponse = vi.fn()
      const popupSender = {
        url: "chrome-extension://fakeid/popup.html"
      } as chrome.runtime.MessageSender

      // Get pending swap id
      let pendingId: number | undefined
      onMessageListener({ type: "GET_PENDING_SWAP" }, popupSender, (res: any) => {
        pendingId = res.id
      })
      expect(typeof pendingId).toBe("number")

      onMessageListener({ type: "APPROVE_SWAP", id: pendingId }, popupSender, sendResponse)
      const swap2Result = await swap2Promise
      expect(swap2Result).toBe(true)
    })
  })
})
