/**
 * A group stop is a maximal run of adjacent cards sharing a stop key, in the
 * sidebar's drawn order; an empty group never forms one. A jump lands in the
 * neighbouring stop on the card remembered for its key while that card is
 * still in it, else on its first card. Movement stops at the ends.
 */
export function groupJump<T>(cards: readonly T[], index: number, step: 1 | -1,
  stopOf: (card: T) => string, identity: (card: T) => string, memory: ReadonlyMap<string, string>): T | undefined {
  if (!cards[index]) return undefined
  const stops: Array<{ key: string; cards: T[] }> = []
  let current = -1
  cards.forEach((card, i) => {
    const key = stopOf(card)
    if (stops.at(-1)?.key !== key) stops.push({ key, cards: [] })
    stops.at(-1)!.cards.push(card)
    if (i === index) current = stops.length - 1
  })
  const target = stops[current + step]
  if (!target) return undefined
  const remembered = memory.get(target.key)
  return target.cards.find(card => identity(card) === remembered) ?? target.cards[0]
}
