// Note selection for the popup's two spend paths (#195). `notes` mixes native
// SOL notes with shielded SPL notes whose `amount` is in the token's own base
// units, and the two defects here are both silent: a transfer sends the wrong
// asset, or a whole class of notes can never be spent. Neither throws at the
// point of the mistake, so each case is pinned explicitly.

import type { ShieldedNote } from "~lib/paraloom/notes"
import {
  maxSolWithdrawLamports,
  resolveSpendAsset,
  selectSolWithdrawNotes,
  selectTransferInputs,
  spendableSolNotes,
  unspentNativeNotes,
  WITHDRAW_DUST_LAMPORTS
} from "~lib/paraloom/noteSelection"
import { NATIVE_ASSET_HEX } from "~lib/prover"
import { describe, expect, it, vi } from "vitest"

// noteSelection reaches ~lib/prover for the native asset id, and the wasm module
// cannot load under vitest.
vi.mock("~lib/prover", () => ({ NATIVE_ASSET_HEX: "00".repeat(32) }))

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
// mint_to_asset(mint) is a one-way hash; only its shape matters here.
const USDC_ASSET = "5a".repeat(32)

function sol(lamports: bigint | string, overrides: Partial<ShieldedNote> = {}): ShieldedNote {
  return {
    amount: lamports.toString(),
    blinding: "aa".repeat(32),
    assetId: NATIVE_ASSET_HEX,
    signature: "",
    createdAt: 1,
    spent: false,
    ...overrides
  }
}

function usdc(raw: bigint, overrides: Partial<ShieldedNote> = {}): ShieldedNote {
  return sol(raw, {
    assetId: USDC_ASSET,
    mint: USDC_MINT,
    ...overrides
  })
}

describe("selectTransferInputs", () => {
  it("does not let a larger raw SPL amount hijack a SOL transfer", () => {
    // 1000 USDC is 1_000_000_000 raw, well above 0.8 SOL of lamports. Left in
    // the list, the SPL note sorts first, spendV3 infers isSpl from inputs[0]
    // and the wallet sends 500 USDC where 0.5 SOL was asked for.
    const notes = [usdc(1_000_000_000n), sol(800_000_000n)]
    const inputs = selectTransferInputs(notes, 500_000_000n)
    expect(inputs).toHaveLength(1)
    expect(inputs![0].assetId).toBe(NATIVE_ASSET_HEX)
  })

  it("takes a second NATIVE note so a two-note selection stays single-asset", () => {
    // The other half of the same bug, and the one that THROWS: the SPL note
    // alone cannot cover 1 SOL, so the old code paired it with a SOL note and
    // spendV3 rejected the pair with "all spent notes must share one asset",
    // breaking a transfer the user could plainly afford.
    const notes = [sol(600_000_000n), usdc(900_000_000n), sol(600_000_000n)]
    const inputs = selectTransferInputs(notes, 1_000_000_000n)
    expect(inputs).toHaveLength(2)
    expect(inputs!.every((n) => n.assetId === NATIVE_ASSET_HEX)).toBe(true)
    expect(inputs!.every((n) => !n.mint)).toBe(true)
    // And the pair the old selection produced is exactly what the guard rejects.
    expect(() => resolveSpendAsset([usdc(900_000_000n), sol(600_000_000n)])).toThrow(
      /share one asset/
    )
  })

  it("accepts a sub-dust note as the second input", () => {
    // Nothing is paid out of the note on a transfer, so dust is fine here and
    // filtering it would fail an otherwise affordable spend.
    const notes = [sol(700_000n), sol(500n)]
    expect(selectTransferInputs(notes, 700_500n)!.map((n) => n.amount)).toEqual(["700000", "500"])
  })

  it("returns null when native notes cannot cover the amount", () => {
    expect(selectTransferInputs([sol(1n), usdc(500_000_000_000n)], 2n)).toBeNull()
  })

  it("ignores spent notes", () => {
    expect(selectTransferInputs([sol(10n, { spent: true }), sol(5n)], 8n)).toBeNull()
  })
})

describe("note ordering", () => {
  it("sorts by exact bigint value above Number.MAX_SAFE_INTEGER", () => {
    // Neighbours at 2^53 are the same double, so a comparator that converts an
    // amount to Number cannot tell these two notes apart at all — it reports a
    // tie and leaves them in storage order.
    const big = 9007199254740992n // 2^53
    expect(Number(big)).toBe(Number(big + 1n))

    // Largest first, with the larger of the two leading regardless of input order.
    const notes = [sol(big), sol(big + 1n)]
    expect(unspentNativeNotes(notes).map((n) => n.amount)).toEqual([
      "9007199254740993",
      "9007199254740992"
    ])
    // ...and the selection takes the genuinely largest as its primary.
    expect(selectSolWithdrawNotes(notes, 1n)![0].amount).toBe("9007199254740993")
  })
})

describe("selectSolWithdrawNotes", () => {
  it("uses a sub-dust note as the second input", () => {
    // The circuit pads a one-note spend with a zero dummy input, so the second
    // slot costs nothing extra. Filtering dust out of it stranded those notes
    // forever while shieldedBalance() kept counting them.
    const notes = [sol(2_000_000n), sol(999_999n)]
    const inputs = selectSolWithdrawNotes(notes, 2_500_000n)
    expect(inputs!.map((n) => n.amount)).toEqual(["2000000", "999999"])
  })

  it("still excludes a lone sub-dust note as the single input", () => {
    expect(selectSolWithdrawNotes([sol(WITHDRAW_DUST_LAMPORTS - 1n)], 1n)).toBeNull()
  })

  it("spends a spendable note alone when it already covers the amount", () => {
    // The dust note must not be dragged in as a free second input.
    const notes = [sol(10_000_000n), sol(500n)]
    expect(selectSolWithdrawNotes(notes, 5_000_000n)).toHaveLength(1)
  })

  it("returns null rather than a partial selection when the gap is too wide", () => {
    expect(selectSolWithdrawNotes([sol(2_000_000n), sol(100n)], 3_000_000n)).toBeNull()
  })

  it("allows a pair whose SUM clears the threshold even when neither note does", () => {
    // Both are dust alone, but 0.0012 SOL together is worth a withdraw, and the
    // pair costs the same proof as one note.
    const notes = [sol(700_000n), sol(500_000n)]
    expect(selectSolWithdrawNotes(notes, 1_000_000n)).toHaveLength(2)
  })

  it("returns null for a pair that stays below the threshold", () => {
    expect(selectSolWithdrawNotes([sol(400n), sol(400n)], 700n)).toBeNull()
  })

  it("returns null with no spendable note at all", () => {
    expect(selectSolWithdrawNotes([usdc(9_000_000_000n)], 1n)).toBeNull()
  })
})

describe("maxSolWithdrawLamports", () => {
  it("counts the second note, dust included", () => {
    expect(maxSolWithdrawLamports([sol(2_000_000n), sol(999_999n)])).toBe(2_999_999n)
  })

  it("is zero when only a lone dust note is left", () => {
    expect(maxSolWithdrawLamports([sol(999n)])).toBe(0n)
  })

  it("is zero when the whole pair stays below the threshold", () => {
    expect(maxSolWithdrawLamports([sol(400n), sol(400n)])).toBe(0n)
  })

  it("agrees with what the selector can actually choose", () => {
    const notes = [sol(3_000_000n), sol(400n), usdc(50_000_000n)]
    expect(selectSolWithdrawNotes(notes, maxSolWithdrawLamports(notes))).not.toBeNull()
  })
})

describe("spendableSolNotes", () => {
  it("still hides dust from the picker but keeps it in the native list", () => {
    const notes = [sol(2_000_000n), sol(999n), usdc(9n)]
    expect(spendableSolNotes(notes).map((n) => n.amount)).toEqual(["2000000"])
    expect(unspentNativeNotes(notes).map((n) => n.amount)).toEqual(["2000000", "999"])
  })

  it("treats a note with no assetId as native", () => {
    const legacy = sol(5n)
    delete (legacy as { assetId?: string }).assetId
    expect(unspentNativeNotes([legacy])).toHaveLength(1)
  })
})

describe("resolveSpendAsset (#195 guard)", () => {
  it("returns the native asset for native inputs", () => {
    expect(resolveSpendAsset([sol(1n), sol(2n)], NATIVE_ASSET_HEX)).toBe(NATIVE_ASSET_HEX)
  })

  it("throws when a native caller is handed an SPL note", () => {
    expect(() => resolveSpendAsset([usdc(1n)], NATIVE_ASSET_HEX)).toThrow(/expected asset/)
  })

  it("throws on a mixed-asset input pair", () => {
    expect(() => resolveSpendAsset([sol(1n), usdc(1n)])).toThrow(/share one asset/)
  })

  it("keeps SPL callers working by inferring from the inputs", () => {
    expect(resolveSpendAsset([usdc(1n)])).toBe(USDC_ASSET)
    expect(resolveSpendAsset([usdc(1n)], USDC_ASSET)).toBe(USDC_ASSET)
  })

  it("defaults a note with no assetId to native", () => {
    const legacy = sol(1n)
    delete (legacy as { assetId?: string }).assetId
    expect(resolveSpendAsset([legacy])).toBe(NATIVE_ASSET_HEX)
  })
})
