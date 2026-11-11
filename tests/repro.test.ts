
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest"

// ---- Mocks: local note storage + proof generation (isolate transfer.ts) ----
const markNoteSpent = vi.fn(async (..._a: unknown[]) => {})
const markNoteSpentByCommitment = vi.fn(async (..._a: unknown[]) => {})
const addDiscoveredNote = vi.fn(async (..._a: unknown[]) => {})

const NOTE_A = {
  amount: "600",
  blinding: "11".repeat(32),
  assetId: "00".repeat(32),
  signature: "sigA",
  commitment: "aa".repeat(32),
  createdAt: 1,
  spent: false,
}
const NOTE_B = {
  amount: "600",
  blinding: "22".repeat(32),
  assetId: "00".repeat(32),
  signature: "sigB",
  commitment: "bb".repeat(32),
  createdAt: 2,
  spent: false,
}

vi.mock("../lib/paraloom/notes", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>
  return {
    ...orig,
    markNoteSpent: (...a: unknown[]) => markNoteSpent(...a),
    markNoteSpentByCommitment: (...a: unknown[]) => markNoteSpentByCommitment(...a),
    addDiscoveredNote: (...a: unknown[]) => addDiscoveredNote(...a),
    getNotes: vi.fn(async () => [NOTE_A, NOTE_B]),
    getUnspentNotes: vi.fn(async () => [NOTE_A, NOTE_B]),
    loadNotes: vi.fn(async () => [NOTE_A, NOTE_B]),
  }
})

const proveTransferV2 = vi.fn(async (..._a: unknown[]) => ({
  proof: "00",
  publicInputs: [],
}))

vi.mock("../lib/paraloom/transact", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>
  return { ...orig, proveTransferV2: (...a: unknown[]) => proveTransferV2(...a) }
})

const ROOT_1 = "11".repeat(32)
const ROOT_2 = "22".repeat(32)

function installFetch(roots: [string, string]) {
  let pathCall = 0
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes("/transfer/submit")) {
      return { ok: true, status: 200, json: async () => ({ request_id: "req-1" }) }
    }
    // merkle path lookups
    const root = roots[Math.min(pathCall++, 1)]
    return {
      ok: true,
      status: 200,
      json: async () => ({
        root,
        path: Array(20).fill("00".repeat(32)),
        pathElements: Array(20).fill("00".repeat(32)),
        pathIndices: Array(20).fill(0),
        leafIndex: pathCall,
        leaf_index: pathCall,
      }),
      text: async () => "",
    }
  })
  ;(globalThis as any).fetch = fetchMock
  return fetchMock
}

;(globalThis as any).chrome = {
  storage: {
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
    },
  },
}

async function runTransfer() {
  const mod: any = await import("../lib/