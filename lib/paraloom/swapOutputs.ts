import { getSessionStorage, setSessionStorage } from "~lib/storage/session"

export interface SwapOutput {
  freshAddress: string
  freshSecretKeyHex: string
  outputMint: string
  outAmount: number
  swapSignature: string
  reshield: boolean
  createdAt: number
  reshieldRecovered?: boolean
}

const SWAP_OUTPUTS_KEY = "paraloom_swap_outputs"

// Mutex lock to prevent read-modify-write races across async storage calls
let storageLock = Promise.resolve()

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  let release: () => void = () => {}
  const nextLock = new Promise<void>((resolve) => {
    release = resolve
  })
  const prevLock = storageLock
  storageLock = nextLock
  await prevLock
  try {
    return await fn()
  } finally {
    release()
  }
}

export async function listSwapOutputs(): Promise<SwapOutput[]> {
  return withLock(async () => {
    const raw = await getSessionStorage<string>(SWAP_OUTPUTS_KEY)
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  })
}

export async function saveSwapOutput(output: SwapOutput): Promise<void> {
  return withLock(async () => {
    const raw = await getSessionStorage<string>(SWAP_OUTPUTS_KEY)
    let outputs: SwapOutput[] = []
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) outputs = parsed
      } catch {
        outputs = []
      }
    }
    const idx = outputs.findIndex((o) => o.freshAddress === output.freshAddress)
    if (idx >= 0) {
      outputs[idx] = { ...outputs[idx], ...output }
    } else {
      outputs.push(output)
    }
    await setSessionStorage(SWAP_OUTPUTS_KEY, JSON.stringify(outputs))
  })
}

export async function dismissSwapOutput(freshAddress: string): Promise<void> {
  return withLock(async () => {
    const raw = await getSessionStorage<string>(SWAP_OUTPUTS_KEY)
    if (!raw) return
    let outputs: SwapOutput[] = []
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) outputs = parsed
    } catch {
      return
    }
    const filtered = outputs.filter((o) => o.freshAddress !== freshAddress)
    await setSessionStorage(SWAP_OUTPUTS_KEY, JSON.stringify(filtered))
  })
}
