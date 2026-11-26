import {
  dismissSwapOutput,
  listSwapOutputs,
  saveSwapOutput,
  type SwapOutput
} from "~lib/paraloom/swapOutputs"
import { beforeEach, describe, expect, it } from "vitest"
import { installFakeChrome, installUnlockedSession, type FakeChrome } from "./support/chromeStorage"

const SECRET = "cc".repeat(32)
const OTHER_SECRET = "dd".repeat(32)

let fake: FakeChrome

function output(overrides: Partial<SwapOutput> = {}): SwapOutput {
  return {
    freshAddress: "FreshAddr11111111111111111111111111111111",
    freshSecretKeyHex: SECRET,
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    outAmount: 5000,
    swapSignature: "",
    reshield: true,
    createdAt: 1,
    ...overrides
  }
}

beforeEach(async () => {
  fake = installFakeChrome()
  await installUnlockedSession()
})

describe("sealed at-rest storage (#1724)", () => {
  it("writes fresh secret keys as one opaque sealed blob, never plaintext", async () => {
    await saveSwapOutput(output())

    const raw = fake.storage.local.raw["paraloom_swap_outputs"]
    expect(typeof raw).toBe("string")
    expect(raw as string).toMatch(/^v1:[0-9a-f]+$/)
    // The fresh secret key is a bearer key: it must not appear anywhere in
    // what hits the disk.
    expect(raw as string).not.toContain(SECRET)
    expect(raw as string).not.toContain("FreshAddr11111111111111111111111111111111")
  })

  it("round-trips outputs through the seal while unlocked", async () => {
    await saveSwapOutput(output())

    const rows = await listSwapOutputs()
    expect(rows).toHaveLength(1)
    expect(rows[0].freshSecretKeyHex).toBe(SECRET)
  })

  it("returns nothing while locked, as if the store were empty", async () => {
    await saveSwapOutput(output())
    // Simulate LOCK_WALLET: the session (and with it the sealing key) is gone.
    await fake.storage.session.remove("paraloom_session")

    expect(await listSwapOutputs()).toEqual([])
    // The sealed blob itself is still on disk, unreadable — not deleted.
    expect(typeof fake.storage.local.raw["paraloom_swap_outputs"]).toBe("string")
  })

  it("refuses writes while locked instead of dropping them silently", async () => {
    await fake.storage.session.remove("paraloom_session")

    await expect(saveSwapOutput(output())).rejects.toThrow(/locked/)
    expect(fake.storage.local.raw["paraloom_swap_outputs"]).toBeUndefined()
  })

  it("seals legacy plaintext rows on the first unlocked read", async () => {
    // A pre-#1724 wallet: fresh secret keys sitting in the clear.
    await fake.storage.local.set({ paraloom_swap_outputs: [output()] })
    expect(typeof fake.storage.local.raw["paraloom_swap_outputs"]).not.toBe("string")

    const rows = await listSwapOutputs()
    expect(rows).toHaveLength(1)
    expect(rows[0].freshSecretKeyHex).toBe(SECRET)

    const raw = fake.storage.local.raw["paraloom_swap_outputs"]
    expect(typeof raw).toBe("string")
    expect(raw as string).toMatch(/^v1:/)
    expect(raw as string).not.toContain(SECRET)
  })

  it("refuses to open a store sealed under a different wallet", async () => {
    await saveSwapOutput(output())
    await installUnlockedSession(9)

    await expect(listSwapOutputs()).rejects.toThrow(/authentication/)
  })

  it("dismisses a row from the sealed store", async () => {
    await saveSwapOutput(output())
    await saveSwapOutput(
      output({
        freshAddress: "OtherAddr2222222222222222222222222222222",
        freshSecretKeyHex: OTHER_SECRET
      })
    )

    await dismissSwapOutput("FreshAddr11111111111111111111111111111111")

    const rows = await listSwapOutputs()
    expect(rows).toHaveLength(1)
    expect(rows[0].freshSecretKeyHex).toBe(OTHER_SECRET)
  })
})

describe("fresh-key expiry on re-shield recovery (#1724)", () => {
  it("drops the secret key once the re-shield is recovered", async () => {
    await saveSwapOutput(output({ swapSignature: "sig-landed" }))

    // The recovery already used the key to deposit the note; the row is now
    // only an Activity record, and the fresh address holds nothing.
    await saveSwapOutput({ ...output(), swapSignature: "sig-landed", reshieldRecovered: true })

    const rows = await listSwapOutputs()
    expect(rows).toHaveLength(1)
    expect(rows[0].reshieldRecovered).toBe(true)
    expect(rows[0].freshSecretKeyHex).toBe("")
    // And the sealed blob on disk no longer contains the key either.
    expect(fake.storage.local.raw["paraloom_swap_outputs"] as string).not.toContain(SECRET)
  })

  it("keeps the key while the swap is only landed, not re-shielded", async () => {
    // A landed swap whose token still sits at the fresh address: the key is
    // the only way to move it, so recording the signature must not drop it.
    await saveSwapOutput(output())
    await saveSwapOutput({ ...output(), outAmount: 6000, swapSignature: "sig-landed" })

    const rows = await listSwapOutputs()
    expect(rows).toHaveLength(1)
    expect(rows[0].swapSignature).toBe("sig-landed")
    expect(rows[0].freshSecretKeyHex).toBe(SECRET)
  })

  it("keeps the key for a row that never asked to re-shield", async () => {
    await saveSwapOutput(output({ reshield: false, swapSignature: "sig-landed" }))

    const rows = await listSwapOutputs()
    expect(rows[0].freshSecretKeyHex).toBe(SECRET)
  })
})
