import * as bip39 from "bip39"

/** Pick `count` random unique indices from `0..max-1`, sorted ascending. */
export function pickRandom(count: number, max: number): number[] {
  const indices = Array.from({ length: max }, (_, i) => i)
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[indices[i], indices[j]] = [indices[j], indices[i]]
  }
  return indices.slice(0, count).sort((a, b) => a - b)
}

/**
 * Pick `count` distinct decoy words from the full BIP-39 wordlist, excluding
 * the entire user seed phrase (`seedWords`) as well as `correctWord` (#306).
 *
 * Drawing decoys from the displayed 12-word seed phrase allowed solving the
 * verification quiz by elimination without writing the seed down.
 */
export function pickDecoys(
  correctWord: string,
  seedWords: string[],
  count: number = 3,
  wordlist: string[] = bip39.wordlists.english
): string[] {
  const excluded = new Set<string>([correctWord, ...seedWords])
  const pool = Array.from(new Set(wordlist.filter((w) => !excluded.has(w))))
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, count)
}

/**
 * Build shuffled multiple-choice options for each quizzed seed position.
 */
export function buildVerifyOptions(
  words: string[],
  hiddenIndices: number[],
  decoyCount: number = 3,
  wordlist: string[] = bip39.wordlists.english
): Record<number, string[]> {
  if (words.length !== 12 || hiddenIndices.length === 0) return {}
  const opts: Record<number, string[]> = {}
  for (const idx of hiddenIndices) {
    const correct = words[idx]
    const decoys = pickDecoys(correct, words, decoyCount, wordlist)
    const choices = [correct, ...decoys]
    for (let i = choices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[choices[i], choices[j]] = [choices[j], choices[i]]
    }
    opts[idx] = choices
  }
  return opts
}
