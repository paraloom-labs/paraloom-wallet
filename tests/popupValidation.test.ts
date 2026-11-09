import { describe, expect, it, vi } from "vitest"

vi.mock("~lib/prover", () => ({ NATIVE_ASSET_HEX: "00".repeat(32) }))

import {
  parsePendingConnection,
  parsePendingSwap
} from "../src/popup/index"

describe("parsePendingConnection validation (#257)", () => {
  it("rejects non-object or nullish values", () => {
    expect(parsePendingConnection(null)).toBeNull()
    expect(parsePendingConnection(undefined)).toBeNull()
    expect(parsePendingConnection("string")).toBeNull()
    expect(parsePendingConnection(123)).toBeNull()
  })

  it("rejects non-numeric or NaN/Infinite id", () => {
    expect(parsePendingConnection({ id: "1", origin: "https://paraloom.io" })).toBeNull()
    expect(parsePendingConnection({ id: Number.NaN, origin: "https://paraloom.io" })).toBeNull()
    expect(parsePendingConnection({ id: Number.POSITIVE_INFINITY, origin: "https://paraloom.io" })).toBeNull()
  })

  it("rejects missing or empty origin", () => {
    expect(parsePendingConnection({ id: 1 })).toBeNull()
    expect(parsePendingConnection({ id: 1, origin: "" })).toBeNull()
    expect(parsePendingConnection({ id: 1, origin: "   " })).toBeNull()
    expect(parsePendingConnection({ id: 1, origin: 1234 })).toBeNull()
  })

  it("accepts valid connection request and trims origin", () => {
    expect(parsePendingConnection({ id: 42, origin: "  https://paraloom.io  " })).toEqual({
      id: 42,
      origin: "https://paraloom.io"
    })
  })
})

describe("parsePendingSwap validation (#257)", () => {
  it("rejects non-object, non-numeric id, or empty origin", () => {
    expect(parsePendingSwap(null)).toBeNull()
    expect(parsePendingSwap({ id: "bad", origin: "https://paraloom.io", params: {} })).toBeNull()
    expect(parsePendingSwap({ id: Number.NaN, origin: "https://paraloom.io", params: {} })).toBeNull()
    expect(parsePendingSwap({ id: 1, origin: "  ", params: {} })).toBeNull()
  })

  it("rejects missing, null, or non-object params", () => {
    expect(parsePendingSwap({ id: 1, origin: "https://paraloom.io" })).toBeNull()
    expect(parsePendingSwap({ id: 1, origin: "https://paraloom.io", params: null })).toBeNull()
    expect(parsePendingSwap({ id: 1, origin: "https://paraloom.io", params: "not an object" })).toBeNull()
  })

  it("rejects invalid outputMint or amountLamports", () => {
    // Missing outputMint
    expect(
      parsePendingSwap({
        id: 1,
        origin: "https://paraloom.io",
        params: { amountLamports: "1000" }
      })
    ).toBeNull()

    // Empty outputMint
    expect(
      parsePendingSwap({
        id: 1,
        origin: "https://paraloom.io",
        params: { outputMint: "   ", amountLamports: "1000" }
      })
    ).toBeNull()

    // Missing amountLamports
    expect(
      parsePendingSwap({
        id: 1,
        origin: "https://paraloom.io",
        params: { outputMint: "SOL" }
      })
    ).toBeNull()

    // Non-string amountLamports
    expect(
      parsePendingSwap({
        id: 1,
        origin: "https://paraloom.io",
        params: { outputMint: "SOL", amountLamports: 1000 }
      })
    ).toBeNull()
  })

  it("accepts valid pendingSwap and parses optional params", () => {
    const raw = {
      id: 10,
      origin: " https://app.paraloom.io ",
      params: {
        outputMint: "  SOL ",
        amountLamports: " 5000000 ",
        inputMint: " EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v ",
        slippageBps: 50,
        reshield: true
      }
    }
    const parsed = parsePendingSwap(raw)
    expect(parsed).toEqual({
      id: 10,
      origin: "https://app.paraloom.io",
      params: {
        outputMint: "SOL",
        amountLamports: "5000000",
        inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        slippageBps: 50,
        reshield: true
      }
    })
  })
})

describe("account index restoration logic (#257)", () => {
  it("distinguishes Account 0 (falsy number) from missing property", () => {
    // Demonstrating the bug fix: `if (session.currentAccountIndex)` vs `if (typeof session.currentAccountIndex === 'number')`
    const sessionWith0 = { currentAccountIndex: 0 }
    const sessionWith1 = { currentAccountIndex: 1 }
    const sessionEmpty = {}

    const shouldSwitch = (s: { currentAccountIndex?: number }) =>
      typeof s.currentAccountIndex === "number"

    expect(shouldSwitch(sessionWith0)).toBe(true)
    expect(shouldSwitch(sessionWith1)).toBe(true)
    expect(shouldSwitch(sessionEmpty)).toBe(false)
  })
})
