// Pure settlement-confirmation helper, deliberately free of the prover, wasm, and
// RPC imports so it can be unit-tested in a plain Node environment. Given a way to
// read the current on-chain leaves, it waits for a target output commitment to
// appear — the atomic signal that a transact settled (the same instruction that
// appends the output commitments records the input nullifiers), so a caller can
// mark the spent inputs only once the commitment is present (paraloom-core#792).

export interface LeafRef {
  commitmentHex: string
}

// Outer ceiling for `confirmSettledWith`: how long a caller-supplied predicate is
// re-polled (including after transient errors) before the spend is reported
// unsettled. Settlement is a 2-of-2 quorum co-sign plus an on-chain transact, so
// seconds normally; the ceiling tolerates a slow quorum (paraloom-core#792).
export const CONFIRM_TIMEOUT_MS = 150_000
export const CONFIRM_POLL_MS = 3_000

export interface ConfirmDeps {
  /// Deterministic seams for tests; default to real timers/clock in production.
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

function depsOf(deps: ConfirmDeps): Required<ConfirmDeps> {
  return {
    sleep: deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))),
    now: deps.now ?? (() => Date.now())
  }
}

// Poll `fetchLeaves` until `commitmentHex` is among the leaves (→ true) or the
// timeout elapses (→ false). A throw from `fetchLeaves` is treated as a transient
// RPC error and retried until the deadline, never as a settlement failure.
export async function confirmCommitmentInTree(
  fetchLeaves: () => Promise<LeafRef[]>,
  commitmentHex: string,
  timeoutMs: number,
  pollMs: number,
  deps: ConfirmDeps = {}
): Promise<boolean> {
  const { sleep, now } = depsOf(deps)
  const deadline = now() + timeoutMs
  for (;;) {
    try {
      const leaves = await fetchLeaves()
      if (leaves.some((l) => l.commitmentHex === commitmentHex)) return true
    } catch {
      // A transient RPC error mid-rebuild is not a settlement failure — keep
      // polling until the deadline rather than declaring the spend unsettled.
    }
    if (now() >= deadline) return false
    await sleep(pollMs)
  }
}

// Poll an arbitrary caller-supplied settlement predicate — `fetch` resolving
// true means settled. Unlike `confirmCommitmentInTree` the predicate owns its
// own timeout and signals one by returning false, so a false here is final and
// is never re-polled. What is re-polled is a THROW: the predicate runs AFTER
// submitTransact queued the spend, so one failed poll (an RPC hiccup on a
// recipient balance read, say) must not escape spendV3 and skip the
// post-settlement bookkeeping that marks the inputs spent and books the change.
export async function confirmSettledWith(
  fetch: () => Promise<boolean>,
  deps: ConfirmDeps = {}
): Promise<boolean> {
  const { sleep, now } = depsOf(deps)
  const deadline = now() + CONFIRM_TIMEOUT_MS
  for (;;) {
    try {
      return await fetch()
    } catch {
      // Transient error — the spend may still settle, so keep polling.
      if (now() >= deadline) return false
      await sleep(CONFIRM_POLL_MS)
    }
  }
}
