import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

describe("relay.ts message listener", () => {
  let listeners: ((event: any) => void)[] = []
  let postedMessages: any[] = []
  let sentChromeMessages: any[] = []

  beforeEach(async () => {
    listeners = []
    postedMessages = []
    sentChromeMessages = []

    const fakeWindow: any = {
      addEventListener: vi.fn((type: string, handler: any) => {
        if (type === "message") listeners.push(handler)
      }),
      removeEventListener: vi.fn((type: string, handler: any) => {
        if (type === "message") {
          listeners = listeners.filter((h) => h !== handler)
        }
      }),
      postMessage: vi.fn((data: any) => {
        postedMessages.push(data)
      }),
      location: { origin: "https://app.paraloom.io" }
    }

    const fakeChrome: any = {
      runtime: {
        sendMessage: vi.fn((msg: any, cb?: (res: any) => void) => {
          sentChromeMessages.push(msg)
          if (cb) cb({ success: true })
        }),
        lastError: null
      }
    }

    vi.stubGlobal("window", fakeWindow)
    vi.stubGlobal("chrome", fakeChrome)

    // Re-import relay to attach listener to fresh fakeWindow
    vi.resetModules()
    await import("../src/contents/relay")
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("rejects NaN IDs", () => {
    const handler = listeners[0]
    expect(handler).toBeDefined()

    handler({
      source: window,
      data: {
        channel: "paraloom:request",
        id: NaN,
        type: "IS_CONNECTED"
      }
    })

    expect(sentChromeMessages).toHaveLength(0)
    expect(postedMessages).toHaveLength(0)
  })

  it("rejects non-finite number IDs", () => {
    const handler = listeners[0]

    handler({
      source: window,
      data: {
        channel: "paraloom:request",
        id: Infinity,
        type: "IS_CONNECTED"
      }
    })

    handler({
      source: window,
      data: {
        channel: "paraloom:request",
        id: -Infinity,
        type: "IS_CONNECTED"
      }
    })

    expect(sentChromeMessages).toHaveLength(0)
  })

  it("rejects string non-object payloads instead of spreading", () => {
    const handler = listeners[0]

    handler({
      source: window,
      data: {
        channel: "paraloom:request",
        id: 1,
        type: "IS_CONNECTED",
        payload: "evil-string"
      }
    })

    expect(sentChromeMessages).toHaveLength(0)
  })

  it("rejects array non-object payloads instead of spreading", () => {
    const handler = listeners[0]

    handler({
      source: window,
      data: {
        channel: "paraloom:request",
        id: 2,
        type: "IS_CONNECTED",
        payload: [1, 2, 3]
      }
    })

    expect(sentChromeMessages).toHaveLength(0)
  })

  it("rejects boolean and number non-object payloads", () => {
    const handler = listeners[0]

    handler({
      source: window,
      data: {
        channel: "paraloom:request",
        id: 3,
        type: "IS_CONNECTED",
        payload: 42
      }
    })

    handler({
      source: window,
      data: {
        channel: "paraloom:request",
        id: 4,
        type: "IS_CONNECTED",
        payload: true
      }
    })

    expect(sentChromeMessages).toHaveLength(0)
  })

  it("forwards valid plain object payloads with pinned type", () => {
    const handler = listeners[0]

    handler({
      source: window,
      data: {
        channel: "paraloom:request",
        id: 5,
        type: "SIGN_MESSAGE",
        payload: { message: "hello" }
      }
    })

    expect(sentChromeMessages).toHaveLength(1)
    expect(sentChromeMessages[0]).toEqual({
      message: "hello",
      type: "SIGN_MESSAGE"
    })
    expect(postedMessages).toHaveLength(1)
    expect(postedMessages[0]).toEqual({
      channel: "paraloom:response",
      id: 5,
      result: { success: true },
      error: undefined
    })
  })

  it("forwards undefined payload as empty object with pinned type", () => {
    const handler = listeners[0]

    handler({
      source: window,
      data: {
        channel: "paraloom:request",
        id: 6,
        type: "IS_CONNECTED"
      }
    })

    expect(sentChromeMessages).toHaveLength(1)
    expect(sentChromeMessages[0]).toEqual({
      type: "IS_CONNECTED"
    })
  })
})

describe("inpage.ts bridge", () => {
  let listeners: ((event: any) => void)[] = []
  let postedMessages: any[] = []

  beforeEach(async () => {
    listeners = []
    postedMessages = []

    const fakeWindow: any = {
      addEventListener: vi.fn((type: string, handler: any) => {
        if (type === "message") listeners.push(handler)
      }),
      removeEventListener: vi.fn((type: string, handler: any) => {
        if (type === "message") {
          listeners = listeners.filter((h) => h !== handler)
        }
      }),
      postMessage: vi.fn((data: any) => {
        postedMessages.push(data)
      }),
      location: { origin: "https://app.paraloom.io" }
    }

    vi.stubGlobal("window", fakeWindow)

    vi.resetModules()
    await import("../src/contents/inpage")
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("registers window.paraloom and sends requests with integer IDs", async () => {
    const paraloom = (window as any).paraloom
    expect(paraloom).toBeDefined()

    // Trigger isConnected()
    const promise = paraloom.isConnected()

    expect(postedMessages).toHaveLength(1)
    const req = postedMessages[0]
    expect(req.channel).toBe("paraloom:request")
    expect(typeof req.id).toBe("number")
    expect(Number.isFinite(req.id)).toBe(true)
    expect(Number.isNaN(req.id)).toBe(false)
    expect(req.type).toBe("IS_CONNECTED")

    // Simulate response with NaN id: must be ignored by the listener
    for (const listener of listeners) {
      listener({
        source: window,
        data: {
          channel: "paraloom:response",
          id: NaN,
          result: { connected: true }
        }
      })
    }

    // Now send the legitimate response matching req.id
    for (const listener of listeners) {
      listener({
        source: window,
        data: {
          channel: "paraloom:response",
          id: req.id,
          result: { connected: true }
        }
      })
    }

    const connected = await promise
    expect(connected).toBe(true)
  })
})
