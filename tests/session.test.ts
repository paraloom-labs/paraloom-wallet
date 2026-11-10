import { beforeEach, describe, expect, it } from "vitest"
import type { WalletKeyPair } from "~lib/crypto/keyManagement"
import {
  clearSession,
  deKp,
  fromHex,
  getLastActivity,
  loadSession,
  recordActivity,
  saveSession,
  serKp,
  toHex,
  type WalletSession
} from "~lib/storage/session"
import { installFakeChrome, type FakeChrome } from "./support/chromeStorage"

const validKeyPair: WalletKeyPair = {
  publicKey: new Uint8Array(32).fill(1),
  secretKey: new Uint8Array(64).fill(2),
  shieldedAddress: "paraloom_shielded_test_address_12345",
  boxPublicKey: new Uint8Array(32).fill(3),
  boxSecretKey: new Uint8Array(32).fill(4),
  spendPrivkey: new Uint8Array(32).fill(5)
}

const validSession: WalletSession = {
  wallet: validKeyPair,
  accounts: [
    {
      index: 0,
      name: "Account 1",
      keypair: validKeyPair,
      balance: 1000000000n
    }
  ],
  currentAccountIndex: 0,
  seedPhrase: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
}

describe("fromHex and toHex validation (#232)", () => {
  it("converts bytes to hex and back accurately", () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 255])
    const hex = toHex(bytes)
    expect(hex).toBe("00010f10ff")
    expect(fromHex(hex)).toEqual(bytes)
    expect(fromHex("0x" + hex)).toEqual(bytes)
  })

  it("validates exact byte lengths when expectedLen is specified", () => {
    const hex32 = "ab".repeat(32)
    expect(fromHex(hex32, 32)).toHaveLength(32)
    expect(() => fromHex(hex32, 64)).toThrow(/expected 64 bytes, got 32/i)
    expect(() => fromHex(hex32, 16)).toThrow(/expected 16 bytes, got 32/i)
  })

  it("throws on non-hex characters or odd length", () => {
    expect(() => fromHex("abc")).toThrow(/even length/i)
    expect(() => fromHex("zz")).toThrow(/valid hexadecimal characters/i)
    expect(() => fromHex(123 as unknown as string)).toThrow(/must be a string/i)
  })
})

describe("deKp and serKp validation (#232)", () => {
  it("round-trips a valid WalletKeyPair", () => {
    const ser = serKp(validKeyPair)
    expect(ser.publicKey).toBe("01".repeat(32))
    expect(ser.secretKey).toBe("02".repeat(64))
    expect(ser.shieldedAddress).toBe(validKeyPair.shieldedAddress)

    const deserialized = deKp(ser)
    expect(deserialized.publicKey).toEqual(validKeyPair.publicKey)
    expect(deserialized.secretKey).toEqual(validKeyPair.secretKey)
    expect(deserialized.boxPublicKey).toEqual(validKeyPair.boxPublicKey)
    expect(deserialized.boxSecretKey).toEqual(validKeyPair.boxSecretKey)
    expect(deserialized.spendPrivkey).toEqual(validKeyPair.spendPrivkey)
    expect(deserialized.shieldedAddress).toBe(validKeyPair.shieldedAddress)
  })

  it("throws if any key length is invalid in deKp", () => {
    const ser = serKp(validKeyPair)

    // publicKey must be 32 bytes (64 hex chars), not 31
    expect(() => deKp({ ...ser, publicKey: "01".repeat(31) })).toThrow(/expected 32 bytes/i)

    // secretKey must be 64 bytes (128 hex chars), not 32
    expect(() => deKp({ ...ser, secretKey: "02".repeat(32) })).toThrow(/expected 64 bytes/i)

    // boxPublicKey must be 32 bytes
    expect(() => deKp({ ...ser, boxPublicKey: "03".repeat(33) })).toThrow(/expected 32 bytes/i)

    // boxSecretKey must be 32 bytes
    expect(() => deKp({ ...ser, boxSecretKey: "04".repeat(16) })).toThrow(/expected 32 bytes/i)

    // spendPrivkey must be 32 bytes
    expect(() => deKp({ ...ser, spendPrivkey: "05".repeat(64) })).toThrow(/expected 32 bytes/i)

    // empty or invalid shieldedAddress
    expect(() => deKp({ ...ser, shieldedAddress: "" })).toThrow(/shieldedAddress/i)
  })

  it("throws on invalid key lengths in serKp", () => {
    expect(() =>
      serKp({
        ...validKeyPair,
        publicKey: new Uint8Array(31)
      })
    ).toThrow(/Invalid key length/i)

    expect(() =>
      serKp({
        ...validKeyPair,
        secretKey: new Uint8Array(32)
      })
    ).toThrow(/Invalid key length/i)
  })
})

describe("session lifecycle and defensive loadSession (#232)", () => {
  let fakeChrome: FakeChrome

  beforeEach(() => {
    fakeChrome = installFakeChrome()
  })

  it("saves and loads a valid session successfully", () => {
    return saveSession(validSession).then(async () => {
      const loaded = await loadSession()
      expect(loaded).not.toBeNull()
      expect(loaded!.currentAccountIndex).toBe(0)
      expect(loaded!.seedPhrase).toBe(validSession.seedPhrase)
      expect(loaded!.accounts).toHaveLength(1)
      expect(loaded!.accounts[0].balance).toBe(1000000000n)
      expect(loaded!.wallet.shieldedAddress).toBe(validKeyPair.shieldedAddress)

      const lastActivity = await getLastActivity()
      expect(typeof lastActivity).toBe("number")
    })
  })

  it("returns null when no session is stored", async () => {
    expect(await loadSession()).toBeNull()
  })

  it("handles corrupted non-object session data, clears storage and returns null", async () => {
    await fakeChrome.storage.session.set({ paraloom_session: "corrupted_string_value" })
    const result = await loadSession()
    expect(result).toBeNull()

    // Session should be cleared from storage
    const raw = await fakeChrome.storage.session.get("paraloom_session")
    expect(raw.paraloom_session).toBeUndefined()
  })

  it("handles malformed key hex without crashing, clears storage and returns null", async () => {
    const ser = serKp(validKeyPair)
    // Corrupt publicKey with invalid hex characters
    const corruptedSer = {
      wallet: { ...ser, publicKey: "zz".repeat(32) },
      accounts: [],
      currentAccountIndex: 0,
      seedPhrase: null
    }
    await fakeChrome.storage.session.set({ paraloom_session: corruptedSer })

    const result = await loadSession()
    expect(result).toBeNull()

    const raw = await fakeChrome.storage.session.get("paraloom_session")
    expect(raw.paraloom_session).toBeUndefined()
  })

  it("handles truncated key lengths in stored session, clears storage and returns null", async () => {
    const ser = serKp(validKeyPair)
    const corruptedSer = {
      wallet: { ...ser, secretKey: "02".repeat(32) }, // 32 instead of 64 bytes
      accounts: [],
      currentAccountIndex: 0,
      seedPhrase: null
    }
    await fakeChrome.storage.session.set({ paraloom_session: corruptedSer })

    const result = await loadSession()
    expect(result).toBeNull()

    const raw = await fakeChrome.storage.session.get("paraloom_session")
    expect(raw.paraloom_session).toBeUndefined()
  })

  it("handles corrupted account balance or keypair, clears storage and returns null", async () => {
    const ser = serKp(validKeyPair)
    const corruptedSer = {
      wallet: ser,
      accounts: [
        {
          index: 0,
          name: "Corrupt Account",
          keypair: ser,
          balance: "not_a_valid_bigint_number"
        }
      ],
      currentAccountIndex: 0,
      seedPhrase: null
    }
    await fakeChrome.storage.session.set({ paraloom_session: corruptedSer })

    const result = await loadSession()
    expect(result).toBeNull()

    const raw = await fakeChrome.storage.session.get("paraloom_session")
    expect(raw.paraloom_session).toBeUndefined()
  })

  it("clears session and records activity", async () => {
    await saveSession(validSession)
    await recordActivity(123456789)
    expect(await getLastActivity()).toBe(123456789)

    await clearSession()
    expect(await loadSession()).toBeNull()
    expect(await getLastActivity()).toBeNull()
  })
})
