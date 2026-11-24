// Origin-scoped swap job status (paraloom-core#1665).
//
// `GET_SWAP_STATUS` is polled by the initiating dApp origin while a private
// swap runs in the background service worker. Binding `origin` onto `SwapJob`
// and filtering reads via `readSwapJobForOrigin` prevents a second approved
// origin from reading the first origin's swap result (including the unlinkable
// `freshAddress` and `swapSignature`).

export interface SwapJob {
  status: "pending" | "done" | "error"
  /** Origin that initiated the swap; GET_SWAP_STATUS is gated on matching this origin. */
  origin: string
  result?: unknown
  error?: string
  /** When a "pending" job started, so auto-lock can hold off while a swap is
   *  genuinely in flight without a hung job blocking the lock forever. */
  startedAt?: number
}

/**
 * Return `job` only if it exists, has a non-empty `origin`, and matches
 * `callerOrigin`; otherwise return `null` so cross-origin approved callers
 * never observe another origin's private-swap state or exit address.
 */
export function filterSwapJobForOrigin(
  job: SwapJob | null | undefined,
  callerOrigin: string | null | undefined
): SwapJob | null {
  if (!job || !job.origin || !callerOrigin) return null
  if (job.origin !== callerOrigin) return null
  return job
}
