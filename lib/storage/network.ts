// The selected cluster, isolated from `~lib/storage/secure`.
//
// `secure.ts` is the right home conceptually, but it value-imports
// `lib/crypto/keyManagement`, which pulls the prover wasm — and the pure note
// store (`lib/paraloom/notes.ts`) has to know the cluster it is writing under
// without dragging wasm into every unit test that touches a note. This module
// therefore owns the read/write and `secure.ts` re-exports it, so callers keep
// importing from `secure.ts` unchanged.

export type Network = "mainnet-beta" | "devnet"

// Must match `STORAGE_KEY` in `secure.ts`.
const STORAGE_KEY = "paraloom_wallet"

// New installs default to mainnet-beta (live, capped beta); a previously
// stored choice such as devnet is honoured.
export async function getNetwork(): Promise<Network> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  const storage = result[STORAGE_KEY] as { network?: Network } | undefined
  return storage?.network ?? "mainnet-beta"
}

export async function setNetwork(network: Network): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  // Upsert rather than only-update: the cluster is chosen on first run and
  // again after a wallet wipe, both before any `wallet` record exists.
  const storage = (result[STORAGE_KEY] as Record<string, unknown> | undefined) ?? {}
  storage.network = network
  await chrome.storage.local.set({ [STORAGE_KEY]: storage })
}
