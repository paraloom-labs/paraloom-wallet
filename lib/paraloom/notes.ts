EXPLANATION:
I added a simple guard to `markNoteSpent` and `markNoteSpentByCommitment` to make sure we don't accidentally wipe out transfer or change notes when an empty signature is passed in. This prevents a buggy or malicious call from wiping a user's entire shielded balance by matching every note with an empty string.

CODE:
```typescript
// Local record of the shielded notes this wallet has deposited. Until the
// extension can scan the pool for its own notes (a viewing-key feature), the
// shielded balance is tracked here: the sum of unspent deposits. Each note
// keeps the randomness needed to spend it in a later withdrawal.

// Spend-key note (circuit v2, #293). The note is bound to the account's spend
// public key (derived from the account seed, not stored here); to spend it the
// wallet supplies that account spend privkey plus this note's `blinding`. The
// nullifier is a signature over the commitment — no per-note secret.
export interface ShieldedNote {
  amount: string // lamports, bigint serialized
  blinding: string // hex, 32 bytes (per-note randomizer)
  assetId: string // hex, 32 bytes (all-zero = native SOL)
  // The SPL mint (base58) for a shielded-token note (#779). Absent for native
  // SOL. Kept alongside `assetId` because assetId = mint_to_asset(mint) is a
  // one-way hash, and spending the note must send the mint to the ingress.
  mint?: string
  signature: string // deposit transaction (empty for discovered transfer notes)
  createdAt: number
  spent: boolean
  // Set for notes discovered by scanning transfer ciphertexts (#196). The
  // commitment is the stable identity for received notes (which have no
  // deposit signature) and the de-dup key when re-scanning.
  commitment?: string
  source?: "deposit" | "transfer"
  // Circuit v3 (#350): the note's position in the on-chain incremental tree,
  // recorded at deposit (from DepositNoteEvent) or located by commitment for
  // received notes. Spending needs it for the membership path.
  leafIndex?: number
}

const NOTES_KEY = "paraloom_notes"

type NotesByAccount = Record<string, ShieldedNote[]>

async function readAll(): Promise<NotesByAccount> {
  const stored = await chrome.storage.local.get(NOTES_KEY)
  return (stored[NOTES_KEY] as NotesByAccount) ?? {}
}

async function writeAll(all: NotesByAccount): Promise<void> {
  await chrome.storage.local.set({ [NOTES_KEY]: all })
}

export async function getNotes(account: string): Promise<ShieldedNote[]> {
  const all = await readAll()
  return all[account] ?? []
}

export async function addNote(account: string, note: ShieldedNote): Promise<void> {
  const all = await readAll()
  const existing = all[account] ?? []
  // Idempotent by (non-empty) deposit signature: the same shielded note can be
  // persisted more than once — the early on-submit persist AND the end-of-flow
  // persist AND the recovery scan all target the same deposit — so dedupe here
  // rather than double-counting the balance.
  if (note.signature && existing.some((n) => n.signature === note.signature)) {
    return
  }
  all[account] = [...existing, note]
  await writeAll(all)
}

// Mark the note with this deposit signature as spent (after a withdrawal
// settles), so it no longer counts toward the shielded balance.
export async function markNoteSpent(account: string, signature: string): Promise<void> {
  if (!signature || signature.trim() === "") {
    return
  }
  const all = await readAll()
  const notes = all[account] ?? []
  all[account] = notes.map((n) => (n.signature === signature ? { ...n, spent: true } : n))
  await writeAll(all)
}

// Mark a note as spent by its commitment (for received/transfer notes that
// have no deposit signature).
export async function markNoteSpentByCommitment(account: string, commitment: string): Promise<void> {
  if (!commitment || commitment.trim() ===