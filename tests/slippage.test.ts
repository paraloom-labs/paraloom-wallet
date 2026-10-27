import { describe, expect, it } from "vitest"

import {
  DEFAULT_SLIPPAGE_BPS,
  effectiveSlippageBps,
  MAX_SLIPPAGE_BPS
} from "~lib/paraloom/slippage"

describe("effectiveSlippageBps", () => {
  it("falls back to the default when the caller asks for nothing", () => {
    expect(effectiveSlippageBps(undefined)).toBe(DEFAULT_SLIPPAGE_BPS)
  })

  it("falls back to the default on non-numeric or non-finite input", () => {
    expect(effectiveSlippageBps(Number.NaN)).toBe(DEFAULT_SLIPPAGE_BPS)
    expect(effectiveSlippageBps(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SLIPPAGE_BPS)
    // A page can send anything across the message bridge; the type says number.
    expect(effectiveSlippageBps("50" as unknown as number)).toBe(DEFAULT_SLIPPAGE_BPS)
  })

  it("passes a sane request through unchanged", () => {
    expect(effectiveSlippageBps(10)).toBe(10)
    expect(effectiveSlippageBps(100)).toBe(100)
  })

  it("rounds fractional basis points", () => {
    expect(effectiveSlippageBps(12.6)).toBe(13)
  })

  it("holds the value between 1 bps and the ceiling", () => {
    expect(effectiveSlippageBps(0)).toBe(1)
    expect(effectiveSlippageBps(-50)).toBe(1)
    expect(effectiveSlippageBps(99_999)).toBe(MAX_SLIPPAGE_BPS)
  })
})
