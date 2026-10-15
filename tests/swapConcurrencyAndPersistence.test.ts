import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  assetIdForMint: vi.fn(async () => "11".repeat(32))
}))

import { installFakeChrome } from "./support/chromeStorage"

type MessageListener = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
) => boolean | void

let listeners: MessageListener[] = []

function setupChromeRuntimeMocks() {
  const storage = installFakeChrome()
  listeners = []
  const g = globalThis as unknown as { chrome: any }
  g.chrome.alarms = {
    create: vi.fn(),
    onAlarm: { addListener: vi.fn() }
  }
  g.chrome.windows = {
    getLastFocused: vi.fn(async () => ({ left: 0, top: 0, width: 1200 })),
    create: vi.fn(async () => ({}))
  }
  g.chrome.runtime = {
    getURL: (path: string) => `chrome-extension://test-ext-id/${path}`,
    getPlatformInfo: vi.fn(async () => ({ os: "linux" })),
    sendMessage: vi.fn(),
    onMessage: {
      addListener: (fn: MessageListener) => {
        listeners.push(fn)
      }
    }
  }
  return storage
}

function dispatchMessage(
  message: any,
  sender: chrome.runtime.MessageSender
): Promise<any> {
  return new Promise((resolve) => {
    for (const fn of listeners) {
      fn(message, sender, (resp) => resolve(resp))
    }
  })
}

beforeEach(async () => {
  vi.resetModules()
  setupChromeRuntimeMocks()
})

describe("PRIVATE_SWAP concurrency & persisted pendingSwap", () => {
  const DAPP_ORIGIN = "https://app.paraloom.io"
  const DAPP_SENDER: chrome.runtime.MessageSender = {
    origin: DAPP_ORIGIN,
    url: `${DAPP_ORIGIN}/swap`,
    tab: { id: 1, url: `${DAPP_ORIGIN}/swap` } as chrome.tabs.Tab
  }
  const POPUP_SENDER: chrome.runtime.MessageSender = {
    url: "chrome-extension://test-ext-id/popup.html"
  }

  it("persists pendingSwap in chrome.storage.session and rejects concurrent PRIVATE_SWAP while one is in flight", async () => {
    const { addApprovedOrigin } = await import("~lib/storage/connections")
    const { setLockState } = await import("~lib/storage/secure")
    await addApprovedOrigin(DAPP_ORIGIN)
    await setLockState(false)

    await import("~src/background/index")

    const swap1Params = {
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amountLamports: "50000000",
      reshield: true
    }

    // 1. First PRIVATE_SWAP starts and persists both swapJob and pendingSwap in session storage
    const res1 = await dispatchMessage(
      { type: "PRIVATE_SWAP", params: swap1Params },
      DAPP_SENDER
    )
    expect(res1.success).toBe(true)
    expect(res1.pending).toBe(true)

    // Give runSwapJob microtask a tick to register pendingSwap
    await new Promise((r) => setTimeout(r, 20))

    const sessionData = await chrome.storage.session.get(["swapJob", "pendingSwap"])
    expect(sessionData.swapJob).toMatchObject({ status: "pending" })
    expect(sessionData.pendingSwap).toMatchObject({
      origin: DAPP_ORIGIN,
      params: swap1Params
    })

    // 2. Concurrent PRIVATE_SWAP while the first is in flight is rejected instead of clobbering
    const swap2Params = {
      outputMint: "So11111111111111111111111111111111111111112",
      amountLamports: "999999999"
    }
    const res2 = await dispatchMessage(
      { type: "PRIVATE_SWAP", params: swap2Params },
      DAPP_SENDER
    )
    expect(res2.success).toBe(false)
    expect(res2.error).toMatch(/already in progress/i)

    // 3. Popup GET_PENDING_SWAP still sees the original swap1 request intact
    const pending = await dispatchMessage(
      { type: "GET_PENDING_SWAP" },
      POPUP_SENDER
    )
    expect(pending).not.toBeNull()
    expect(pending.params).toEqual(swap1Params)

    // 4. Rejecting the first swap clears pendingSwap and marks swapJob as rejected
    await dispatchMessage(
      { type: "REJECT_SWAP", id: pending.id },
      POPUP_SENDER
    )
    await new Promise((r) => setTimeout(r, 20))

    const statusAfter = await dispatchMessage(
      { type: "GET_SWAP_STATUS" },
      DAPP_SENDER
    )
    expect(statusAfter).toMatchObject({ status: "error", error: "rejected" })
  })
})
