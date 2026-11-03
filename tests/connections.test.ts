// Regression tests for paraloom-wallet#138's durable origin approvals.
//
// A revoked origin must be denied immediately, including after a background
// worker restart. The old `isAuthorizedSender` short-circuited on the in-memory
// `connectedOrigin`, so removing the approval from storage did not revoke the
// live dApp session.

import { beforeEach, describe, expect, it } from "vitest"

import {
  addApprovedOrigin,
  getApprovedOrigins,
  isOriginApproved,
  removeApprovedOrigin
} from "~lib/storage/connections"
import { installFakeChrome } from "./support/chromeStorage"

describe("durable origin approvals (#138)", () => {
  beforeEach(() => {
    installFakeChrome()
  })

  it("revokes an origin by removing it from durable storage", async () => {
    const origin = "https://app.paraloom.io"
    await addApprovedOrigin(origin)
    await expect(isOriginApproved(origin)).resolves.toBe(true)

    await removeApprovedOrigin(origin)
    await expect(isOriginApproved(origin)).resolves.toBe(false)
    await expect(getApprovedOrigins()).resolves.toEqual([])
  })

  it("does not add duplicates", async () => {
    const origin = "https://app.paraloom.io"
    await addApprovedOrigin(origin)
    await addApprovedOrigin(origin)
    await expect(getApprovedOrigins()).resolves.toEqual([origin])
  })
})
