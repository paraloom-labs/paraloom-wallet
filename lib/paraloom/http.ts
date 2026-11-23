import { INGRESS_TIMEOUT_MS } from "./constants"

/**
 * Fetch with an explicit timeout deadline (#303).
 *
 * Prevents hanging indefinitely if a node or proxy accepts the TCP connection
 * but never responds. Aborts the underlying network request and rejects if the
 * response is not received within `timeoutMs`.
 */
export async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  timeoutMs: number = INGRESS_TIMEOUT_MS
): Promise<Response> {
  const ctrl = new AbortController()
  let timer: NodeJS.Timeout | number | undefined

  if (init.signal) {
    if (init.signal.aborted) {
      ctrl.abort(init.signal.reason)
    } else {
      init.signal.addEventListener("abort", () => ctrl.abort(init.signal!.reason), { once: true })
    }
  }

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort()
      reject(
        new Error(`fetchWithTimeout: request to ${url.toString()} timed out after ${timeoutMs}ms`)
      )
    }, timeoutMs)
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      ;(timer as { unref: () => void }).unref()
    }
  })

  try {
    return await Promise.race([fetch(url, { ...init, signal: ctrl.signal }), timeoutPromise])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}
