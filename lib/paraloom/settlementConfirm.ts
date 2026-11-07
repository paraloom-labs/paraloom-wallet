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

function normalizeHex(h: string): string {
  const s = h.trim().toLowerCase()
  return s.startsWith("0x") ? s.slice(2) : s
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
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const now = deps.now ?? (() => Date.now())
  const target = normalizeHex(commitmentHex)
  const effectivePollMs = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 1_000
  const deadline = now() + timeoutMs
  for (;;) {
    try {
      const leaves = await fetchLeaves()
      if (leaves.some((l) => normalizeHex(l.commitmentHex) === target)) return true
    } catch {
      // A transient RPC error mid-rebuild is not a settlement failure — keep
      // polling until the deadline rather than declaring the spend unsettled.
    }
    const remaining = deadline - now()
    if (remaining <= 0) return false
    await sleep(Math.min(effectivePollMs, remaining))
  }
}
