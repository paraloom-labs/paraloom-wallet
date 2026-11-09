// Pure settlement-confirmation helper, deliberately free of the prover, wasm, and
// RPC imports so it can be unit-tested in a plain Node environment. Given a way to
// read the current on-chain leaves, it waits for a target output commitment to
// appear — the atomic signal that a transact settled (the same instruction that
// appends the output commitments records the input nullifiers), so a caller can
// mark the spent inputs only once the commitment is present (paraloom-core#792).

export interface LeafRef {
  commitmentHex: string
}

export interface ConfirmDeps {
  /// Deterministic seams for tests; default to real timers/clock in production.
  sleep?: (ms: number) => Promise<void>
  now?: () => number
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
  const targetHex = typeof commitmentHex === "string" ? commitmentHex.trim().toLowerCase() : ""
  if (!/^[0-9a-f]{64}$/.test(targetHex)) {
    throw new Error(`invalid commitmentHex: expected 64-character hex string, got "${commitmentHex}"`)
  }
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive finite number")
  }
  if (typeof pollMs !== "number" || !Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error("pollMs must be a positive finite number")
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const now = deps.now ?? (() => Date.now())
  const deadline = now() + timeoutMs

  for (;;) {
    try {
      const leaves = await fetchLeaves()
      if (
        Array.isArray(leaves) &&
        leaves.some(
          (l) => typeof l?.commitmentHex === "string" && l.commitmentHex.trim().toLowerCase() === targetHex
        )
      ) {
        return true
      }
    } catch {
      // A transient RPC error mid-rebuild is not a settlement failure — keep
      // polling until the deadline rather than declaring the spend unsettled.
    }

    const currentTime = now()
    if (currentTime >= deadline) {
      return false
    }

    const sleepMs = Math.min(pollMs, deadline - currentTime)
    if (sleepMs <= 0) {
      return false
    }
    await sleep(sleepMs)
  }
}
