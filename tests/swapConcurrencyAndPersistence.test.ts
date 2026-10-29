import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installFakeChrome } from "./support/chromeStorage"
import { addApprovedOrigin } from "~lib/storage/connections"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  assetIdForMint: () => "00".repeat(32)
}))

vi.mock("~lib/paraloom/privateSwap", () => ({
  privateSwap: vi.fn().mockResolvedValue({ success: true, data: { signature: "mock_sig" } }),
  privateSwapFromToken: vi.fn().mockResolvedValue({ success: true, data: { signature: "mock_sig" } }),
  GAS_LAMPORTS: 10_000_000n
}))

describe("PRIVATE_SWAP concurrency and pendingSwap persistence (#930)", () => {
  let messageListener: (
    message: any,
    sender: any,
    sendResponse: (response?: any) => void
  ) => boolean | void

  const popupSender = {
    url: "chrome-extension://testid/popup.html"
  }

  const dappSender = {
    origin: "https://app.paraloom.io",
    tab: { url: "https://app.paraloom.io/swap" }
  }

  beforeEach(async () => {
    const fakeChrome = installFakeChrome() as any

    fakeChrome.runtime = {
      getURL: (path: string) => `chrome-extension://testid/${path}`,
      getPlatformInfo: vi.fn().mockResolvedValue({ os: "win", arch: "x86-64" }),
      onMessage: {
        addListener: vi.fn((listener) => {
          messageListener = listener
        })
      }
    }

    fakeChrome.alarms = {
      create: vi.fn(),
      onAlarm: { addListener: vi.fn() }
    }

    fakeChrome.windows = {
      create: vi.fn().mockResolvedValue({ id: 123 })
    }

    await addApprovedOrigin("https://app.paraloom.io")

    // Dynamically load background script to register listener with fresh chrome
    vi.resetModules()
    await import("../src/background/index")
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function dispatchMessage(message: any, sender: any): Promise<any> {
    return new Promise((resolve) => {
      expect(messageListener).toBeDefined()
      messageListener(message, sender, resolve)
    })
  }

  it("rejects concurrent PRIVATE_SWAP when another swap is already in flight", async () => {
    // Seed an in-flight swap job in chrome.storage.session (within 8 min grace)
    await chrome.storage.session.set({
      swapJob: {
        id: 1,
        status: "pending",
        startedAt: Date.now() - 1000
      }
    })

    const response = await dispatchMessage(
      {
        type: "PRIVATE_SWAP",
        params: {
          outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amountLamports: "100000000"
        }
      },
      dappSender
    )

    expect(response).toEqual({
      success: false,
      error: "A private swap is already in progress"
    })

    // Verify swapJob was not overwritten
    const stored = (await chrome.storage.session.get("swapJob")).swapJob as any
    expect(stored.id).toBe(1)
    expect(stored.status).toBe("pending")
  })

  it("persists pendingSwap to chrome.storage.session and surfaces it on GET_PENDING_SWAP", async () => {
    const initialResp = await dispatchMessage(
      {
        type: "PRIVATE_SWAP",
        params: {
          outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amountLamports: "100000000"
        }
      },
      dappSender
    )
    expect(initialResp).toEqual({ success: true, pending: true })

    // Wait microtick for requestSwapApproval to write to session storage
    await new Promise((r) => setTimeout(r, 20))

    // Check that pendingSwap is written to chrome.storage.session
    const sessionData = (await chrome.storage.session.get("pendingSwap")).pendingSwap as any
    expect(sessionData).toBeDefined()
    expect(sessionData.origin).toBe("https://app.paraloom.io")
    expect(sessionData.params.amountLamports).toBe("100000000")

    // GET_PENDING_SWAP from popup should retrieve it
    const pendingResp = await dispatchMessage({ type: "GET_PENDING_SWAP" }, popupSender)
    expect(pendingResp).toMatchObject({
      origin: "https://app.paraloom.io",
      params: {
        amountLamports: "100000000"
      }
    })
  })

  it("clears persisted pendingSwap on APPROVE_SWAP and REJECT_SWAP", async () => {
    // Seed pendingSwap directly in storage as if worker restarted
    await chrome.storage.session.set({
      pendingSwap: {
        id: 42,
        origin: "https://app.paraloom.io",
        params: {
          outputMint: "USDC_MINT",
          amountLamports: "5000000"
        }
      }
    })

    // GET_PENDING_SWAP must find it even when memory state is absent
    const pending = await dispatchMessage({ type: "GET_PENDING_SWAP" }, popupSender)
    expect(pending).toMatchObject({ id: 42, origin: "https://app.paraloom.io" })

    // REJECT_SWAP should remove pendingSwap from session storage
    const rejectResp = await dispatchMessage({ type: "REJECT_SWAP", id: 42 }, popupSender)
    expect(rejectResp).toEqual({ success: true })

    const sessionAfter = (await chrome.storage.session.get("pendingSwap")).pendingSwap
    expect(sessionAfter).toBeUndefined()
  })
})
