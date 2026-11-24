import * as bip39 from "bip39"
import { describe, expect, it } from "vitest"
import {
  buildVerifyOptions,
  pickDecoys,
  pickRandom
} from "~lib/crypto/seedVerification"

describe("seed phrase verification quiz (#306)", () => {
  it("draws decoys from the full BIP-39 wordlist and never includes any word from the user's seed phrase", () => {
    const seed = bip39.generateMnemonic(128)
    const words = seed.split(" ")
    expect(words).toHaveLength(12)
    const seedSet = new Set(words)

    for (let trial = 0; trial < 20; trial++) {
      for (const word of words) {
        const decoys = pickDecoys(word, words, 3)
        expect(decoys).toHaveLength(3)
        expect(new Set(decoys).size).toBe(3)
        for (const decoy of decoys) {
          expect(bip39.wordlists.english).toContain(decoy)
          expect(seedSet.has(decoy)).toBe(false)
        }
      }
    }
  })

  it("produces 4 distinct options per hidden index even when the mnemonic has repeated words", () => {
    // 11x "abandon" + "about" is a valid 12-word BIP-39 mnemonic
    const repeatedWords = [
      "abandon",
      "abandon",
      "abandon",
      "abandon",
      "abandon",
      "abandon",
      "abandon",
      "abandon",
      "abandon",
      "abandon",
      "abandon",
      "about"
    ]
    const hidden = pickRandom(3, 12)
    const opts = buildVerifyOptions(repeatedWords, hidden, 3)

    for (const idx of hidden) {
      const choices = opts[idx]
      expect(choices).toHaveLength(4)
      expect(new Set(choices).size).toBe(4)
      expect(choices).toContain(repeatedWords[idx])
      const decoys = choices.filter((c) => c !== repeatedWords[idx])
      expect(decoys).toHaveLength(3)
      for (const d of decoys) {
        expect(repeatedWords).not.toContain(d)
      }
    }
  })
})
