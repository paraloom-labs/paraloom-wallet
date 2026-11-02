// Regression test for paraloom-labs/paraloom-wallet#206
// Shielded notes must be scoped by cluster: the same shielded address serves
// both mainnet-beta and devnet, so a note added on one network must NOT appear
// in the other network's list or balance.

import { getNotes, addNote, shieldedBalance } from "~lib/paraloom/notes"
import { setNetwork } from "~lib/storage/secure"

const ACCOUNT = "paraloom1" + "ab".repeat(32)

function note(amount: string, signature: string) {
  return {
    amount,
    blinding: "00".repeat(32),
    assetId: "00".repeat(32),
    signature,
    createdAt: Date.now(),
    spent: false
  }
}

describe("notes cluster scoping (#206)", () => {
  beforeEach(async () => {
    await (chrome.storage.local as any).clear?.()
    await setNetwork("mainnet-beta")
  })

  it("a mainnet note does not appear on devnet", async () => {
    await setNetwork("mainnet-beta")
    await addNote(ACCOUNT, note("1000", "sig-main"))
    expect((await getNotes(ACCOUNT)).length).toBe(1)

    await setNetwork("devnet")
    expect((await getNotes(ACCOUNT)).length).toBe(0)
    expect(await shieldedBalance(ACCOUNT)).toBe(0n)

    await setNetwork("mainnet-beta")
    expect((await getNotes(ACCOUNT)).length).toBe(1)
    expect(await shieldedBalance(ACCOUNT)).toBe(1000n)
  })

  it("devnet and mainnet balances are independent", async () => {
    await setNetwork("mainnet-beta")
    await addNote(ACCOUNT, note("500", "sig-m"))
    await setNetwork("devnet")
    await addNote(ACCOUNT, note("700", "sig-d"))

    await setNetwork("mainnet-beta")
    expect(await shieldedBalance(ACCOUNT)).toBe(500n)
    await setNetwork("devnet")
    expect(await shieldedBalance(ACCOUNT)).toBe(700n)
  })
})
