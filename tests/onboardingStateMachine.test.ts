import React from "react"
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

;(globalThis as unknown as { React: typeof React }).React = React

// Mock Plasmo data-base64 asset import and wallet dependencies
vi.mock("data-base64:~/../assets/icon.png", () => ({
  default: "data:image/png;base64,AA=="
}))

vi.mock("~lib/crypto/keyManagement", () => ({
  generateSeedPhrase: () =>
    "abandon ability able about above absent absorb abstract absurd abuse access accident",
  validateSeedPhrase: (s: string) => s.trim().split(/\s+/).length === 12,
  deriveKeypairFromSeed: vi.fn(),
  encryptWallet: vi.fn()
}))

vi.mock("~lib/storage/secure", () => ({
  saveEncryptedWallet: vi.fn(),
  setLockState: vi.fn()
}))

vi.mock("~lib/store/walletStore", () => ({
  useWalletStore: () => ({
    unlock: vi.fn(),
    addAccount: vi.fn(),
    setSeedPhrase: vi.fn()
  })
}))

// Minimal stateful React hook harness to drive the real Onboarding component
let hookState: unknown[] = []
let memoState: { deps: unknown[]; val: unknown }[] = []
let refState: { current: unknown }[] = []
let effectState: (() => (() => void) | void)[] = []
let hookCursor = 0
let memoCursor = 0
let refCursor = 0

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react")
  return {
    ...actual,
    useState: (initial: unknown) => {
      const idx = hookCursor++
      if (!(idx in hookState)) {
        hookState[idx] = typeof initial === "function" ? (initial as () => unknown)() : initial
      }
      const setState = (val: unknown) => {
        hookState[idx] =
          typeof val === "function" ? (val as (prev: unknown) => unknown)(hookState[idx]) : val
      }
      return [hookState[idx], setState]
    },
    useMemo: (factory: () => unknown, deps: unknown[]) => {
      const idx = memoCursor++
      const prev = memoState[idx]
      const changed =
        !prev ||
        prev.deps.length !== deps.length ||
        deps.some((d, i) => !Object.is(d, prev.deps[i]))
      if (changed) {
        memoState[idx] = { deps, val: factory() }
      }
      return memoState[idx].val
    },
    useRef: (initial: unknown) => {
      const idx = refCursor++
      if (!(idx in refState)) {
        refState[idx] = { current: initial }
      }
      return refState[idx]
    },
    useEffect: (effect: () => (() => void) | void) => {
      effectState.push(effect)
    }
  }
})

import { Onboarding } from "../src/popup/Onboarding"

type VNode = {
  type: unknown
  props?: {
    className?: string
    onClick?: () => void
    onChange?: (e: { target: { value: string } }) => void
    value?: string
    children?: unknown
  }
}

function collectNodes(node: unknown, out: VNode[] = []): VNode[] {
  if (!node || typeof node !== "object") return out
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out)
    return out
  }
  const vnode = node as VNode
  out.push(vnode)
  if (vnode.props?.children !== undefined) {
    collectNodes(vnode.props.children, out)
  }
  return out
}

function textOf(node: unknown): string {
  if (node == null || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (typeof node === "object" && (node as VNode).props) {
    return textOf((node as VNode).props?.children)
  }
  return ""
}

function renderOnboarding(onComplete = () => {}) {
  hookCursor = 0
  memoCursor = 0
  refCursor = 0
  const tree = Onboarding({ onComplete })
  const nodes = collectNodes(tree)
  const buttons = nodes.filter((n) => n.type === "button")
  const findButton = (labelSubstring: string) =>
    buttons.find((b) => textOf(b).includes(labelSubstring))
  return { tree, nodes, buttons, findButton, fullText: textOf(tree) }
}

describe("Onboarding wizard state-machine fixes (src/popup/Onboarding.tsx)", () => {
  beforeEach(() => {
    hookState = []
    memoState = []
    refState = []
    effectState = []
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("Bug 1 fixed: clicking 'Back' on Step 3 returns to Step 2 with 'Continue' button enabling forward navigation", () => {
    // 1. Welcome -> Create New Wallet
    let view = renderOnboarding()
    view.findButton("Create New Wallet")!.props!.onClick!()

    // 2. Step 1 -> Reveal Seed Phrase -> I've Saved It — Verify (Step 2)
    view = renderOnboarding()
    view.findButton("Reveal Seed Phrase")!.props!.onClick!()
    view = renderOnboarding()
    view.findButton("I've Saved It — Verify")!.props!.onClick!()

    // 3. Answer all 3 quiz questions correctly on Step 2
    const seedWords = (hookState[2] as string).split(" ")
    const hiddenIndices = memoState[0].val as number[]
    expect(hiddenIndices.length).toBe(3)

    for (let q = 0; q < 3; q++) {
      view = renderOnboarding()
      const wordIdx = hiddenIndices[q]
      const correctWord = seedWords[wordIdx]
      const optBtn = view.buttons.find((b) => textOf(b) === correctWord)!
      optBtn.props!.onClick!()
      vi.advanceTimersByTime(q < 2 ? 300 : 600)
    }

    // Now on Step 3 (Create Password)
    view = renderOnboarding()
    expect(view.fullText).toContain("Step 3 of 3")

    // 4. User clicks "Back" on Step 3
    view.findButton("Back")!.props!.onClick!()

    // 5. Returned to Step 2, where allDone === true renders Continue button alongside Back to Seed Phrase
    view = renderOnboarding()
    expect(view.fullText).toContain("Step 2 of 3")
    expect(view.fullText).toContain("Seed phrase verified!")

    const continueBtn = view.findButton("Continue")
    expect(continueBtn).toBeDefined()

    const backBtn = view.findButton("Back to Seed Phrase")
    expect(backBtn).toBeDefined()

    // 6. Clicking Continue advances back to Step 3 without repeating seed verification
    continueBtn!.props!.onClick!()
    view = renderOnboarding()
    expect(view.fullText).toContain("Step 3 of 3")
  })

  it("Bug 2A fixed: clicking 'Back to Seed Phrase' cancels pending 600ms timer so wizard stays on Step 1", () => {
    let view = renderOnboarding()
    view.findButton("Create New Wallet")!.props!.onClick!()
    view = renderOnboarding()
    view.findButton("Reveal Seed Phrase")!.props!.onClick!()
    view = renderOnboarding()
    view.findButton("I've Saved It — Verify")!.props!.onClick!()

    const seedWords = (hookState[2] as string).split(" ")
    const hiddenIndices = memoState[0].val as number[]

    // Answer first 2 questions
    for (let q = 0; q < 2; q++) {
      view = renderOnboarding()
      const correctWord = seedWords[hiddenIndices[q]]
      view.buttons.find((b) => textOf(b) === correctWord)!.props!.onClick!()
      vi.advanceTimersByTime(300)
    }

    // Answer 3rd question (schedules setTimeout(() => setCreateStep(3), 600))
    view = renderOnboarding()
    const thirdCorrectWord = seedWords[hiddenIndices[2]]
    view.buttons.find((b) => textOf(b) === thirdCorrectWord)!.props!.onClick!()

    // Within 600ms, user clicks "Back to Seed Phrase" (resets createStep=1, verifyAnswers={})
    view = renderOnboarding()
    view.findButton("Back to Seed Phrase")!.props!.onClick!()
    view = renderOnboarding()
    expect(view.fullText).toContain("Step 1 of 3")
    expect(hookState[8]).toEqual({})

    // Advance 600ms: cancelled timer does not fire, wizard remains safely on Step 1
    vi.advanceTimersByTime(600)
    view = renderOnboarding()
    expect(view.fullText).toContain("Step 1 of 3")
    expect(hookState[1]).toBe(1)
    expect(hookState[8]).toEqual({})
  })

  it("Bug 2B fixed: wrong option click cancels pending 300ms timer so activeQuestionIdx stays reset at 0", () => {
    let view = renderOnboarding()
    view.findButton("Create New Wallet")!.props!.onClick!()
    view = renderOnboarding()
    view.findButton("Reveal Seed Phrase")!.props!.onClick!()
    view = renderOnboarding()
    view.findButton("I've Saved It — Verify")!.props!.onClick!()

    const seedWords = (hookState[2] as string).split(" ")
    const hiddenIndices = memoState[0].val as number[]

    // Click correct word for question 0 (schedules setActiveQuestionIdx(1) in 300ms)
    view = renderOnboarding()
    const firstCorrect = seedWords[hiddenIndices[0]]
    view.buttons.find((b) => textOf(b) === firstCorrect)!.props!.onClick!()

    // Before 300ms elapses, user clicks a wrong option on question 0
    view = renderOnboarding()
    const wrongOption = view.buttons.find(
      (b) => b.props?.className === "verify-option" && textOf(b) !== firstCorrect
    )!
    wrongOption.props!.onClick!()

    // Immediately after wrong click, quiz is reset (verifyAnswers = {}, activeQuestionIdx = 0)
    expect(hookState[8]).toEqual({})
    expect(hookState[10]).toBe(0)

    // Advance 300ms: cancelled timer does not fire, activeQuestionIdx remains 0
    vi.advanceTimersByTime(300)
    expect(hookState[8]).toEqual({})
    expect(hookState[10]).toBe(0)
  })

  it("Bug 3 fixed: Step 1 of Create Wallet has Back button to Welcome, and state is cleaned across Welcome, Import, and Create flows", () => {
    // 1. Go to Import Existing Wallet, enter dirty seedPhrase + mismatched password, trigger error
    let view = renderOnboarding()
    view.findButton("Import Existing Wallet")!.props!.onClick!()
    view = renderOnboarding()

    const textarea = view.nodes.find((n) => n.type === "textarea")!
    textarea.props!.onChange!({ target: { value: "dirty invalid mnemonic" } })
    const pwInputs = view.nodes.filter((n) => n.type === "input")
    pwInputs[0].props!.onChange!({ target: { value: "password123" } })
    pwInputs[1].props!.onChange!({ target: { value: "mismatch456" } })

    view = renderOnboarding()
    view.findButton("Import Wallet")!.props!.onClick!()
    view = renderOnboarding()
    expect(view.fullText).toContain("Passwords do not match")

    // 2. Click "Back" to return to Welcome, then re-open Import
    view.findButton("Back")!.props!.onClick!()
    view = renderOnboarding()
    expect(view.fullText).toContain("Privacy-first shielded wallet")

    view.findButton("Import Existing Wallet")!.props!.onClick!()
    view = renderOnboarding()

    // State is cleanly reset
    expect(hookState[2]).toBe("")
    expect(hookState[4]).toBe("")
    expect(hookState[5]).toBe("")
    expect(hookState[6]).toBe("")
    expect(view.fullText).not.toContain("Passwords do not match")

    // 3. Return to Welcome and switch to Create New Wallet (Step 1): Back button to Welcome exists!
    view.findButton("Back")!.props!.onClick!()
    view = renderOnboarding()
    view.findButton("Create New Wallet")!.props!.onClick!()
    view = renderOnboarding()
    expect(view.fullText).toContain("Step 1 of 3")

    const backToWelcomeBtn = view.findButton("Back")
    expect(backToWelcomeBtn).toBeDefined()

    // 4. Test clicking Back from Create Step 1 returns to Welcome
    backToWelcomeBtn!.props!.onClick!()
    view = renderOnboarding()
    expect(view.fullText).toContain("Privacy-first shielded wallet")

    // 5. Enter Create New Wallet again, advance to Create Step 3 and verify no stale error, password, or confirmPassword
    view.findButton("Create New Wallet")!.props!.onClick!()
    view = renderOnboarding()
    view.findButton("Reveal Seed Phrase")!.props!.onClick!()
    view = renderOnboarding()
    view.findButton("I've Saved It — Verify")!.props!.onClick!()

    const seedWords = (hookState[2] as string).split(" ")
    const hiddenIndices = memoState[0].val as number[]
    for (let q = 0; q < 3; q++) {
      view = renderOnboarding()
      const correctWord = seedWords[hiddenIndices[q]]
      view.buttons.find((b) => textOf(b) === correctWord)!.props!.onClick!()
      vi.advanceTimersByTime(q < 2 ? 300 : 600)
    }

    view = renderOnboarding()
    expect(view.fullText).toContain("Step 3 of 3")
    expect(view.fullText).not.toContain("Passwords do not match")
    expect(hookState[4]).toBe("")
    expect(hookState[5]).toBe("")
    expect(hookState[6]).toBe("")
  })
})
