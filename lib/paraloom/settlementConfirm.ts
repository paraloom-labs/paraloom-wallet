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

/// On-chain withdrawal fee rate (25 bps = 0.25%), matching `WITHDRAWAL_FEE_BPS`
/// in `programs/paraloom/src/lib.rs`.
export const WITHDRAWAL_FEE_BPS = 25n
export const BPS_DENOMINATOR = 10_000n

/// Compute the net payout (in lamports or token base units) delivered to the
/// recipient by an on-chain `transact` withdrawal of `grossAmount` after the
/// 25 bps protocol withdrawal fee (paraloom-core#1632).
export function expectedWithdrawNetAmount(grossAmount: bigint): bigint {
  if (grossAmount <= 0n) return 0n
  const fee = (grossAmount * WITHDRAWAL_FEE_BPS) / BPS_DENOMINATOR
  return grossAmount - fee
}

/// Check whether the recipient's balance rose by at least the expected net
/// payout of `grossWithdrawAmount`. Rejects 1-lamport dust or smaller unrelated
/// transfers that would otherwise trigger a false settlement confirmation and
/// prematurely mark input notes spent (paraloom-core#1632).
export function hasExpectedBalanceRise(
  beforeBalance: number | bigint,
  currentBalance: number | bigint,
  grossWithdrawAmount: bigint
): boolean {
  if (grossWithdrawAmount <= 0n) return false
  const before = BigInt(beforeBalance)
  const current = BigInt(currentBalance)
  if (current <= before) return false
  const delta = current - before
  return delta >= expectedWithdrawNetAmount(grossWithdrawAmount)
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
