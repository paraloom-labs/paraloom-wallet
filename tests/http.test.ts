import { fetchWithTimeout } from "~lib/paraloom/http"
import { describe, expect, it, vi } from "vitest"

describe("fetchWithTimeout (#303)", () => {
  it("resolves when the request completes before the timeout", async () => {
    vi.stubGlobal("fetch", async () => {
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    const res = await fetchWithTimeout("https://node.paraloom.io/test", {}, 1000)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("times out and throws when the server hangs indefinitely", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}))

    await expect(fetchWithTimeout("https://node.paraloom.io/hung", {}, 50)).rejects.toThrow(
      /timed out after 50ms/
    )
  })

  it("aborts the underlying fetch when the timeout triggers", async () => {
    let aborted = false
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true
      })
      return new Promise(() => {})
    })

    await expect(fetchWithTimeout("https://node.paraloom.io/abort-check", {}, 50)).rejects.toThrow(
      /timed out/
    )

    expect(aborted).toBe(true)
  })

  it("respects an already aborted caller signal", async () => {
    const ctrl = new AbortController()
    ctrl.abort(new Error("caller aborted"))

    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new Error("already aborted")
      }
      return new Promise(() => {})
    })

    await expect(
      fetchWithTimeout("https://node.paraloom.io/pre-aborted", { signal: ctrl.signal }, 500)
    ).rejects.toThrow()
  })

  it("cleans up timer on successful response", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout")
    vi.stubGlobal("fetch", async () => new Response("ok", { status: 200 }))

    await fetchWithTimeout("https://node.paraloom.io/fast", {}, 1000)
    expect(clearTimeoutSpy).toHaveBeenCalled()
    clearTimeoutSpy.mockRestore()
  })
})
