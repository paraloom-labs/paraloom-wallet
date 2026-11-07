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
  if (typeof commitmentHex !== "string") return false
  const target = commitmentHex.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(target)) return false

  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const now = deps.now ?? (() => Date.now())
  const boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0
  const stepMs = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 1000
  const deadline = now() + boundedTimeoutMs
  for (;;) {
    try {
      const leaves = await fetchLeaves()
      if (
        Array.isArray(leaves) &&
        leaves.some(
          (l) =>
            typeof l?.commitmentHex === "string" &&
            l.commitmentHex.trim().toLowerCase() === target
        )
      ) {
        return true
      }
    } catch {
      // A transient RPC error mid-rebuild is not a settlement failure — keep
      // polling until the deadline rather than declaring the spend unsettled.
    }
    const current = now()
    if (current >= deadline) return false
    await sleep(Math.min(stepMs, deadline - current))
  }
}

const MAX_U64 = (1n << 64n) - 1n

/**
 * Parse a user-entered decimal SOL string into exact integer lamports (9 decimals)
 * without IEEE-754 floating-point precision drift or `BigInt(Infinity)` crashes.
 * Returns `null` on empty, non-decimal, `<= 0`, sub-lamport (`> 9` decimals), or `> u64::MAX`.
 */
export function parseSolInputToLamports(raw: string): bigint | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(trimmed)
  if (!m) return null
  const whole = BigInt(m[1])
  const fracStr = (m[2] ?? "").padEnd(9, "0")
  const frac = BigInt(fracStr)
  const lamports = whole * 1_000_000_000n + frac
  if (lamports <= 0n || lamports > MAX_U64) return null
  return lamports
}
