import { describe, expect, it } from "vitest"
import {
  ACTIVITY_EVENTS,
  ACTIVITY_THROTTLE_MS,
  startActivityHeartbeat
} from "../lib/popup/activityHeartbeat"

function setup() {
  const target = new EventTarget()
  let t = 1_000_000
  let reports = 0
  const stop = startActivityHeartbeat({
    target,
    report: () => {
      reports++
    },
    now: () => t
  })
  return {
    fire: (type: string) => target.dispatchEvent(new Event(type)),
    advance: (ms: number) => {
      t += ms
    },
    reports: () => reports,
    stop
  }
}

describe("startActivityHeartbeat", () => {
  it("reports ongoing interaction, not just the first one (#724 B1)", () => {
    const h = setup()
    // A user actively clicking around the popup for five minutes must keep
    // refreshing the idle clock, so auto-lock measures from the LAST
    // interaction rather than from unlock.
    for (let i = 0; i < 20; i++) {
      h.fire("pointerdown")
      h.advance(ACTIVITY_THROTTLE_MS)
    }
    expect(h.reports()).toBe(20)
  })

  it("reports the first interaction immediately", () => {
    const h = setup()
    h.fire("keydown")
    expect(h.reports()).toBe(1)
  })

  it("throttles bursts to one report per window", () => {
    const h = setup()
    for (let i = 0; i < 50; i++) {
      h.fire("keydown")
      h.advance(100)
    }
    // 50 keystrokes over 5s fall inside a single 15s window.
    expect(h.reports()).toBe(1)
    h.advance(ACTIVITY_THROTTLE_MS)
    h.fire("keydown")
    expect(h.reports()).toBe(2)
  })

  it("counts every genuine input type", () => {
    for (const type of ACTIVITY_EVENTS) {
      const h = setup()
      h.fire(type)
      expect(h.reports(), type).toBe(1)
    }
  })

  it("ignores passive pointer movement and scrolling", () => {
    // A cursor resting on an unattended popup must not keep the wallet open.
    const h = setup()
    h.fire("mousemove")
    h.fire("scroll")
    expect(h.reports()).toBe(0)
  })

  it("stops reporting once detached", () => {
    const h = setup()
    h.stop()
    for (const type of ACTIVITY_EVENTS) h.fire(type)
    expect(h.reports()).toBe(0)
  })
})
