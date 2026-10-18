// Cross-context synchronization utilities using the Web Locks API (supported in
// Chrome MV3 extension contexts) with an in-process serialized queue fallback
// for test and non-browser environments.

type LockTask<T> = () => Promise<T>

const inProcessQueues = new Map<string, Promise<unknown>>()
const inProcessBusyFlags = new Set<string>()

/**
 * Run a task with an exclusive lock across contexts (popup, background, options)
 * using navigator.locks with an in-process queue fallback.
 */
export async function withExclusiveLock<T>(name: string, fn: LockTask<T>): Promise<T> {
  const runWithQueue = async (): Promise<T> => {
    const prev = inProcessQueues.get(name) ?? Promise.resolve()
    let resolveCurrent!: () => void
    const next = new Promise<void>((res) => {
      resolveCurrent = res
    })
    inProcessQueues.set(
      name,
      prev.then(
        () => next,
        () => next
      )
    )
    try {
      await prev
      return await fn()
    } finally {
      resolveCurrent()
    }
  }

  if (typeof navigator !== "undefined" && navigator?.locks?.request) {
    return new Promise<T>((resolve, reject) => {
      navigator.locks
        .request(name, { mode: "exclusive" }, async () => {
          try {
            const res = await runWithQueue()
            resolve(res)
          } catch (err) {
            reject(err)
          }
        })
        .catch(reject)
    })
  }

  return runWithQueue()
}

/**
 * Execute a task with a non-blocking exclusive lock across contexts.
 * If another context holds the lock, calls onBusy (or returns undefined) without blocking.
 */
export async function withNonBlockingLock<T>(
  name: string,
  fn: LockTask<T>,
  onBusy?: () => T | Promise<T>
): Promise<T | undefined> {
  if (typeof navigator !== "undefined" && navigator?.locks?.request) {
    return new Promise<T | undefined>((resolve, reject) => {
      navigator.locks
        .request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
          if (!lock) {
            try {
              const res = onBusy ? await onBusy() : undefined
              resolve(res)
            } catch (err) {
              reject(err)
            }
            return
          }
          if (inProcessBusyFlags.has(name)) {
            try {
              const res = onBusy ? await onBusy() : undefined
              resolve(res)
            } catch (err) {
              reject(err)
            }
            return
          }
          inProcessBusyFlags.add(name)
          try {
            const res = await fn()
            resolve(res)
          } catch (err) {
            reject(err)
          } finally {
            inProcessBusyFlags.delete(name)
          }
        })
        .catch(reject)
    })
  }

  // Non-WebLock environment (e.g. Node.js unit tests)
  if (inProcessBusyFlags.has(name)) {
    return onBusy ? await onBusy() : undefined
  }
  inProcessBusyFlags.add(name)
  try {
    return await fn()
  } finally {
    inProcessBusyFlags.delete(name)
  }
}
