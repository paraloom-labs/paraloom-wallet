import { describe, expect, it, vi, beforeEach } from "vitest"
import { Connection, Keypair, PublicKey } from "@solana/web3.js"
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from "../lib/paraloom/constants"
import {
  associatedTokenAddress,
  buildDepositSplInstruction,
  resolveTokenProgram
} from "../lib/paraloom/bridge"
import { submitTransact } from "../lib/paraloom/transact"
import { recoverReshields } from "../lib/paraloom/reshieldRecovery"
import { installFakeChrome } from "./support/chromeStorage"

vi.mock("~lib/prover", () => ({
  NATIVE_ASSET_HEX: "00".repeat(32),
  assetIdForMint: vi.fn(async () => "01".repeat(32))
}))

describe("Token-2022 support in paraloom-wallet", () => {
  beforeEach(() => {
    installFakeChrome()
    vi.restoreAllMocks()
  })

  describe("resolveTokenProgram", () => {
    it("resolves TOKEN_2022_PROGRAM_ID when mint is owned by Token-2022", async () => {
      const token2022Mint = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
      const mockConn = {
        getAccountInfo: vi.fn().mockResolvedValue({
          owner: new PublicKey(TOKEN_2022_PROGRAM_ID)
        })
      } as unknown as Connection

      const resolved = await resolveTokenProgram(mockConn, token2022Mint)
      expect(resolved.toBase58()).toBe(TOKEN_2022_PROGRAM_ID)
    })

    it("resolves classic TOKEN_PROGRAM_ID when mint is owned by SPL Token", async () => {
      const classicMint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
      const mockConn = {
        getAccountInfo: vi.fn().mockResolvedValue({
          owner: new PublicKey(TOKEN_PROGRAM_ID)
        })
      } as unknown as Connection

      const resolved = await resolveTokenProgram(mockConn, classicMint)
      expect(resolved.toBase58()).toBe(TOKEN_PROGRAM_ID)
    })

    it("falls back to classic TOKEN_PROGRAM_ID on RPC error or non-existent mint", async () => {
      const unknownMint = Keypair.generate().publicKey
      const mockConn = {
        getAccountInfo: vi.fn().mockRejectedValue(new Error("RPC network failure"))
      } as unknown as Connection

      const resolved = await resolveTokenProgram(mockConn, unknownMint)
      expect(resolved.toBase58()).toBe(TOKEN_PROGRAM_ID)
    })
  })

  describe("associatedTokenAddress derivation", () => {
    it("derives different ATAs for Token-2022 vs classic SPL Token programs", () => {
      const owner = Keypair.generate().publicKey
      const mint = Keypair.generate().publicKey

      const classicAta = associatedTokenAddress(
        owner,
        mint,
        new PublicKey(TOKEN_PROGRAM_ID)
      )
      const token2022Ata = associatedTokenAddress(
        owner,
        mint,
        new PublicKey(TOKEN_2022_PROGRAM_ID)
      )

      expect(classicAta.toBase58()).not.toBe(token2022Ata.toBase58())

      // Verify seeds used: [owner, tokenProgram, mint]
      const expected2022 = PublicKey.findProgramAddressSync(
        [owner.toBytes(), new PublicKey(TOKEN_2022_PROGRAM_ID).toBytes(), mint.toBytes()],
        new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID)
      )[0]
      expect(token2022Ata.toBase58()).toBe(expected2022.toBase58())
    })
  })

  describe("buildDepositSplInstruction", () => {
    it("binds the Token-2022 program ID as the token_program account", () => {
      const depositor = Keypair.generate().publicKey
      const mint = Keypair.generate().publicKey
      const ata = Keypair.generate().publicKey
      const token2022Pk = new PublicKey(TOKEN_2022_PROGRAM_ID)

      const ix = buildDepositSplInstruction(
        depositor,
        mint,
        ata,
        1_000_000n,
        new Uint8Array(32),
        new Uint8Array(32),
        token2022Pk
      )

      // Account layout: 0: bridge_state, 1: asset_config, 2: mint, 3: asset_vault,
      // 4: depositor_token_account, 5: merkle_tree, 6: depositor, 7: token_program
      expect(ix.keys[7].pubkey.toBase58()).toBe(TOKEN_2022_PROGRAM_ID)
    })
  })

  describe("submitTransact", () => {
    it("transmits token_program in the request body when tokenProgramHex is provided", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ request_id: "req-123" })
      } as unknown as Response)

      const token2022Hex = Buffer.from(
        new PublicKey(TOKEN_2022_PROGRAM_ID).toBytes()
      ).toString("hex")

      const res = await submitTransact(
        "root123",
        -100n,
        "recipient123",
        JSON.stringify({ nullifiers: [], output_commitments: [], proof: [] }),
        ["ct1", "ct2"],
        undefined,
        "mint123",
        token2022Hex
      )

      expect(res.requestId).toBe("req-123")
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const callBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string)
      expect(callBody.mint).toBe("mint123")
      expect(callBody.token_program).toBe(token2022Hex)
    })
  })

  describe("recoverReshields with Token-2022", () => {
    it("discovers and reshields orphaned funds in Token-2022 ATA", async () => {
      const fresh = Keypair.generate()
      const token2022Mint = Keypair.generate().publicKey

      const { saveSwapOutput } = await import("../lib/paraloom/swapOutputs")
      await saveSwapOutput({
        freshAddress: fresh.publicKey.toBase58(),
        freshSecretKeyHex: Buffer.from(fresh.secretKey).toString("hex"),
        outputMint: token2022Mint.toBase58(),
        outAmount: 500,
        swapSignature: "swap-sig-123",
        reshield: true,
        reshieldRecovered: false,
        createdAt: Date.now() - 60_000
      })

      const token2022Ata = associatedTokenAddress(
        fresh.publicKey,
        token2022Mint,
        new PublicKey(TOKEN_2022_PROGRAM_ID)
      )

      const mockConn = {
        // Signatures for fresh address (Case A check: none found)
        getSignaturesForAddress: vi.fn().mockResolvedValue([]),
        // resolveTokenProgram detects Token-2022 owner
        getAccountInfo: vi.fn().mockImplementation(async (pk: PublicKey) => {
          if (pk.toBase58() === token2022Mint.toBase58()) {
            return { owner: new PublicKey(TOKEN_2022_PROGRAM_ID) }
          }
          return null
        }),
        // getTokenAccountBalance returns 500 units for token2022Ata
        getTokenAccountBalance: vi.fn().mockImplementation(async (pk: PublicKey) => {
          if (pk.toBase58() === token2022Ata.toBase58()) {
            return { value: { amount: "500000" } }
          }
          throw new Error("Account not found")
        }),
        getLatestBlockhash: vi.fn().mockResolvedValue({
          blockhash: Keypair.generate().publicKey.toBase58()
        }),
        sendRawTransaction: vi.fn().mockResolvedValue("deposit-sig-456"),
        getSignatureStatus: vi.fn().mockResolvedValue({
          value: { confirmationStatus: "confirmed" }
        })
      } as unknown as Connection

      const recovered = await recoverReshields(
        mockConn,
        "paraloom1" + "00".repeat(64)
      )

      expect(recovered).toBe(1)
      expect(mockConn.sendRawTransaction).toHaveBeenCalledTimes(1)
    })
  })
})
