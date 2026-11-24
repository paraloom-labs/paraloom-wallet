import { describe, expect, it } from "vitest"
import { filterSwapJobForOrigin, type SwapJob } from "~lib/paraloom/swapJobScope"

const ORIGIN_A = "https://app.paraloom.io"
const ORIGIN_B = "https://partner.paraloom.io"

const FINISHED_JOB: SwapJob = {
  status: "done",
  origin: ORIGIN_A,
  result: {
    freshAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    swapSignature: "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirB",
    outAmount: 1_500_000,
    reshielded: false
  }
}

describe("filterSwapJobForOrigin (paraloom-core#1665)", () => {
  it("returns the swap job when polled by the origin that initiated it", () => {
    expect(filterSwapJobForOrigin(FINISHED_JOB, ORIGIN_A)).toEqual(FINISHED_JOB)
  })

  it("returns null when a different approved origin polls GET_SWAP_STATUS", () => {
    expect(filterSwapJobForOrigin(FINISHED_JOB, ORIGIN_B)).toBeNull()
  })

  it("returns null when the caller origin is missing or the job has no owner origin", () => {
    expect(filterSwapJobForOrigin(FINISHED_JOB, null)).toBeNull()
    expect(filterSwapJobForOrigin(FINISHED_JOB, "")).toBeNull()
    expect(
      filterSwapJobForOrigin({ ...FINISHED_JOB, origin: "" }, ORIGIN_A)
    ).toBeNull()
    expect(filterSwapJobForOrigin(null, ORIGIN_A)).toBeNull()
  })
})
