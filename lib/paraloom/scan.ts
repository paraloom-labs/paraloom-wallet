// Recipient discovery (#196): poll the node's /transact/scan endpoint, trial-
// decrypt every delivered ciphertext with this wallet's box secret, and store
// the notes that decrypt as spendable. Failed decrypts are silent. Shielded
// balance then reflects received transfer notes, not just local deposits.

import { PublicKey } from "@solana/web3.js"
import {
  assetIdForMint,
  NATIVE_ASSET_HEX,
  v3NoteCommitment,
  v3NoteCommitmentAsset,
  v3NotePubkey
} from "~lib/prover"
import { TRANSACT_INGRESS_URL } from "./constants"
import { tryDecryptNote } from "./noteCrypto"
import { addDiscoveredNote, getNotes, repairNoteMint, type ShieldedNote } from "./notes"

interface DeliveredNote {
  output_commitment: string
  ciphertext: string
  // The note's SPL mint, hex, absent for native SOL (#23). The plaintext
  // carries `assetId`, and `assetId = mint_to_asset(mint)` is one-way, so the
  // mint cannot be recovered from a decrypted note and has to travel beside it.
  // Node-supplied and therefore untrusted — bound below, never believed.
  //
  // `null` as well as absent: a Rust `Option<String>` serializes None as null
  // unless the field is also skipped, so both spellings mean "no mint" and a
  // native note must not be rejected for arriving with one of them.
  mint?: unknown
}

const REJECT = Symbol("reject")
const HEX_32_RE = /^[0-9a-fA-F]{64}$/

/**
 * Resolve the mint to store as base58, or REJECT.
 *
 * A native note must carry no mint, and an SPL note must carry one that hashes
 * to the assetId the verified commitment binds. An SPL note delivered without a
 * mint is dropped rather than stored mintless: `shieldedBalance` filters on
 * `!n.mint`, so a token note with no mint would be counted as SOL, and a wrong
 * number the user acts on is worse than an invisible one. Dropping it is also
 * exactly what a node that has not shipped #23 yet produces today.
 *
 * The wire carries hex; `ShieldedNote.mint` is base58, which is what the spend
 * path feeds to `new PublicKey` and what token metadata is keyed by. Storing
 * the wire form would give a note that can be discovered but not spent.
 */
async function verifiedMint(
  mintHex: unknown,
  assetIdHex: string,
  isNative: boolean
): Promise<string | undefined | typeof REJECT> {
  if (isNative) {
    return mintHex == null ? undefined : REJECT
  }
  // Enforce canonical 64-char hex before reaching wasm `hex32` (which calls
  // `s.trim()`) or `Buffer.from(..., "hex")` (which halts on non-hex in Node or
  // nibble-shifts on odd leading whitespace in the browser polyfill), so both
  // `assetIdForMint` and `new PublicKey` operate on the exact same 32 bytes.
  if (typeof mintHex !== "string" || !HEX_32_RE.test(mintHex)) {
    return REJECT
  }
  const canonicalMintHex = mintHex.toLowerCase()
  try {
    const mintBytes = Uint8Array.from(Buffer.from(canonicalMintHex, "hex"))
    if (mintBytes.length !== 32 || Buffer.from(mintBytes).toString("hex") !== canonicalMintHex) {
      return REJECT
    }
    if ((await assetIdForMint(canonicalMintHex)).toLowerCase() !== assetIdHex.toLowerCase()) {
      return REJECT
    }
    return new PublicKey(mintBytes).toBase58()
  } catch {
    // Both calls have to be inside this, not just the decode. `assetIdForMint`
    // reaches wasm `hex32`, which returns Err — a thrown JsValue — on anything
    // that is not 32-byte hex, and the mint is node-supplied, so a malformed one
    // is reachable. Uncaught it leaves `scanForNotes` entirely, and since
    // `/transact/scan` serves the whole feed in arrival order, every note after
    // the offending one goes undiscovered, native ones included. Both call sites
    // swallow the throw, so nothing surfaces. A rejection drops one note; an
    // escaping exception drops the rest of the feed.
    //
    // The decode is in here for its own reason too: a 32-byte value that is not
    // a valid point still hashes to an assetId, so the check above can pass on a
    // mint the spend path cannot use.
    return REJECT
  }
}

async function hasValidStoredMint(
  note: ShieldedNote,
  mintAssetCache: Map<string, string>
): Promise<boolean> {
  const assetId = note.assetId?.toLowerCase()
  if (!assetId || assetId === NATIVE_ASSET_HEX) {
    return note.mint == null
  }
  if (typeof note.mint !== "string" || note.mint.length === 0) {
    return false
  }
  try {
    const pk = new PublicKey(note.mint)
    if (pk.toBase58() !== note.mint) {
      return false
    }
    let derivedAsset = mintAssetCache.get(note.mint)
    if (derivedAsset === undefined) {
      const canonicalHex = Buffer.from(pk.toBytes()).toString("hex")
      derivedAsset = (await assetIdForMint(canonicalHex)).toLowerCase()
      mintAssetCache.set(note.mint, derivedAsset)
    }
    return derivedAsset === assetId
  } catch {
    return false
  }
}

// Scan for and store notes owned by this wallet. Returns how many new notes
// were discovered. The note is spent later with the account's own spend key
// (#293), so no per-note secret is stored.
//
// `spendPrivkeyHex` is required to VERIFY each delivered note, not to spend it.
// The box public key that gates decryption is the public half of the shielded
// address, so anyone who knows a victim's address can seal a ciphertext to
// them claiming any amount. Trusting the server-supplied `output_commitment`
// after a successful decrypt let a griefer inject a phantom note whose stored
// commitment does not bind the decrypted (amount, blinding) under the victim's
// spend key: it inflated the balance and, because it can never be found in the
// on-chain tree, bricked every subsequent transfer. We now recompute the
// commitment ourselves and store the note only if it matches.
export async function scanForNotes(
  account: string,
  boxSecretKey: Uint8Array,
  spendPrivkeyHex: string
): Promise<number> {
  const res = await fetch(`${TRANSACT_INGRESS_URL}/transact/scan`)
  if (!res.ok) {
    throw new Error(`Scan failed (${res.status})`)
  }
  const delivered = (await res.json()) as DeliveredNote[]

  const known = new Set<string>()
  const needsMintRepair = new Set<string>()
  const mintAssetCache = new Map<string, string>()
  for (const existing of await getNotes(account)) {
    if (!existing.commitment) continue
    if (await hasValidStoredMint(existing, mintAssetCache)) {
      if (!needsMintRepair.has(existing.commitment)) {
        known.add(existing.commitment)
      }
    } else {
      known.delete(existing.commitment)
      needsMintRepair.add(existing.commitment)
    }
  }
  const spendPubHex = await v3NotePubkey(spendPrivkeyHex)

  let found = 0
  for (const d of delivered) {
    if (known.has(d.output_commitment)) {
      continue
    }
    const note = tryDecryptNote(boxSecretKey, d.ciphertext)
    if (!note) {
      continue
    }
    // The commitment must bind the decrypted amount, blinding and asset under
    // OUR spend key and equal the on-chain output commitment. A mismatch means
    // the ciphertext does not describe the leaf it was delivered with — a
    // crafted or corrupt note — so drop it rather than store an unspendable
    // phantom. An SPL note's leaf binds its assetId, so a native-only
    // recomputation would reject every received token note (#23).
    const isNative = note.assetIdHex === NATIVE_ASSET_HEX
    const expected = isNative
      ? await v3NoteCommitment(note.amount, spendPubHex, note.blindingHex)
      : await v3NoteCommitmentAsset(note.amount, spendPubHex, note.blindingHex, note.assetIdHex)
    if (expected !== d.output_commitment) {
      continue
    }
    // Bind the node-supplied mint to the assetId the commitment already
    // covers. Without this a lying mint files a real balance under the wrong
    // token — the note is genuine, so nothing else would catch it. #196's rule
    // applies to every field the node hands us, not just the commitment.
    const mint = await verifiedMint(d.mint, note.assetIdHex, isNative)
    if (mint === REJECT) {
      continue
    }
    if (needsMintRepair.has(d.output_commitment)) {
      await repairNoteMint(account, d.output_commitment, mint)
      needsMintRepair.delete(d.output_commitment)
      known.add(d.output_commitment)
      continue
    }
    await addDiscoveredNote(account, {
      amount: note.amount.toString(),
      blinding: note.blindingHex,
      assetId: note.assetIdHex,
      mint,
      signature: "",
      createdAt: Date.now(),
      spent: false,
      commitment: d.output_commitment,
      source: "transfer"
    })
    // Track it here too: the same commitment can appear twice in one response,
    // and `known` is otherwise only a snapshot from before the loop, so the
    // note would be stored once but counted twice.
    known.add(d.output_commitment)
    found++
  }
  return found
}
