// A private swap runs against ONE shielded account: it spends that account's
// notes and, on the re-shield leg, deposits back to that account's shielded
// address. The row itself (`lib/paraloom/swapOutputs.ts`) recorded neither the
// account nor the cluster, while `reconcileSwapOutputs` and `recoverReshields`
// walk EVERY row and credit whatever account and connection they were handed.
//
// So a swap stranded under account A is credited to account B whenever B is the
// active account when recovery runs, and `persistReshieldedNote` files the note
// under B. A's balance stays short and B's is inflated with a note it cannot
// spend — B does not hold the spend key the note's commitment binds.

import { addNote, shieldedBalance } from "~lib/paraloom/notes"
import {
  listSwapOutputs,
  listSwapOutputsFor,
  saveSwapOutput,
  type SwapOutput
} from "~lib/paraloom/swapOutputs"
import { beforeEach, describe, expect, it } from "vitest"
import { installFakeChrome } from "./support/chromeStorage"

const ACCOUNT_A = "paraloom1" + "aa".repeat(64)
const ACCOUNT_B = "paraloom1" + "bb".repeat(64)
const MINT = "EPjFWdd5AuEwJ5mN8bZCb6JUU8vE7RRcVEqk3vPaMj2B"

function row(overrides: Partial<SwapOutput> = {}): SwapOutput {
  return {
    freshAddress: "Fresh111111111111111111111111111111111111",
    freshSecretKeyHex: "cd".repeat(64),
    outputMint: MINT,
    outAmount: 0,
    swapSignature: "",
    shieldedAddress: ACCOUNT_A,
    network: "mainnet-beta",
    createdAt: 1,
    ...overrides
  }
}

beforeEach(() => {
  installFakeChrome()
})

describe("swap output rows remember which account owns them", () => {
  it("records the shielded account on the row", async () => {
    await saveSwapOutput(row())
    const [saved] = await listSwapOutputs()
    expect(saved.shieldedAddress).toBe(ACCOUNT_A)
  })

  it("keeps the owner when a later write fills in the realized amount", async () => {
    await saveSwapOutput(row())
    // The upsert that records the landed swap re-sends the row it read; a
    // missing owner in any writer must not erase the one already stored.
    await saveSwapOutput(row({ outAmount: 55, swapSignature: "sig", shieldedAddress: undefined }))
    const [saved] = await listSwapOutputs()
    expect(saved.shieldedAddress).toBe(ACCOUNT_A)
    expect(saved.outAmount).toBe(55)
  })

  it("does not leak one account's rows into another's view via listSwapOutputsFor", async () => {
    await saveSwapOutput(row({ freshAddress: "FreshA", shieldedAddress: ACCOUNT_A }))
    await saveSwapOutput(row({ freshAddress: "FreshB", shieldedAddress: ACCOUNT_B }))
    
    const rowsA = await listSwapOutputsFor(ACCOUNT_A)
    expect(rowsA).toHaveLength(1)
    expect(rowsA[0].freshAddress).toBe("FreshA")

    const rowsB = await listSwapOutputsFor(ACCOUNT_B)
    expect(rowsB).toHaveLength(1)
    expect(rowsB[0].freshAddress).toBe("FreshB")
  })

  it("adopts unowned legacy rows for backward compatibility", async () => {
    await saveSwapOutput(row({ freshAddress: "LegacyFresh", shieldedAddress: undefined }))
    const rows = await listSwapOutputsFor(ACCOUNT_A)
    expect(rows.some(r => r.freshAddress === "LegacyFresh")).toBe(true)
  })

  it("records the cluster, because private swaps always settle on mainnet", async () => {
    await saveSwapOutput(row())
    const [saved] = await listSwapOutputs()
    expect(saved.network).toBe("mainnet-beta")
  })

  it("leaves the note store to file notes under the account it is given", async () => {
    await addNote(ACCOUNT_A, {
      amount: "5",
      blinding: "11".repeat(32),
      assetId: "00".repeat(32),
      signature: "s",
      createdAt: 1,
      spent: false
    })
    expect(await shieldedBalance(ACCOUNT_A)).toBe(5n)
    expect(await shieldedBalance(ACCOUNT_B)).toBe(0n)
  })
})
