// Idle auto-lock is driven by the last-activity timestamp the background worker
// records on an `ACTIVITY` message. The popup used to send that message only at
// unlock, so a user actively working in the popup was still locked out once the
// idle threshold elapsed since unlocking (paraloom-core#724, B1). Report real
// interaction instead, so active use defers the lock and only true idleness
// trips it.

// Genuine user input only. `mousemove`/`scroll` are left out on purpose: a
// cursor resting over or drifting across the popup is not use, and counting it
// would let an unattended wallet stay unlocked indefinitely.
export const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const

// One report per window is plenty: auto-lock is checked on a one-minute alarm
// against a threshold measured in minutes, so a 15s granularity never moves the
// lock by a noticeable amount, while a storage write per keystroke would.
export const ACTIVITY_THROTTLE_MS = 15_000

export interface ActivityHeartbeatOptions {
  /** Where interaction events are observed (the popup `window`). */
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">
  /** Reports activity to the background worker. */
  report: () => void
  now?: () => number
  throttleMs?: number
}

/**
 * Report user interaction on `target`, at most once per `throttleMs`.
 * The first interaction reports immediately. Returns a function that detaches
 * every listener.
 */
export function startActivityHeartbeat({
  target,
  report,
  now = Date.now,
  throttleMs = ACTIVITY_THROTTLE_MS
}: ActivityHeartbeatOptions): () => void {
  let lastReported = -Infinity
  const onActivity = () => {
    const t = now()
    if (t - lastReported < throttleMs) return
    lastReported = t
    report()
  }
  // Capture phase, so an inner handler calling stopPropagation can't hide the
  // interaction; passive, so the wheel/touch listeners never delay scrolling.
  const opts: AddEventListenerOptions = { capture: true, passive: true }
  for (const type of ACTIVITY_EVENTS) target.addEventListener(type, onActivity, opts)
  return () => {
    for (const type of ACTIVITY_EVENTS) target.removeEventListener(type, onActivity, opts)
  }
}
