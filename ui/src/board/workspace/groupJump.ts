/** One group stop: a maximal run of adjacent cards sharing a stop key. */
export interface GroupStop<T> { key: string; cards: T[] }

/** The sidebar's group stops in drawn order; an empty group never forms one. */
export function groupStops<T>(cards: readonly T[], stopOf: (card: T) => string): Array<GroupStop<T>> {
  const stops: Array<GroupStop<T>> = []
  for (const card of cards) {
    const key = stopOf(card)
    if (stops.at(-1)?.key !== key) stops.push({ key, cards: [] })
    stops.at(-1)!.cards.push(card)
  }
  return stops
}

/** A stop is entered on the card remembered for its key while that card is still in it, else on its first card. */
export function stopLanding<T>(stop: GroupStop<T>, identity: (card: T) => string, memory: ReadonlyMap<string, string>): T {
  const remembered = memory.get(stop.key)
  return stop.cards.find(card => identity(card) === remembered) ?? stop.cards[0]
}

/** A jump enters the stop neighbouring the card at `index`. Movement stops at the ends. */
export function groupJump<T>(cards: readonly T[], index: number, step: 1 | -1,
  stopOf: (card: T) => string, identity: (card: T) => string, memory: ReadonlyMap<string, string>): T | undefined {
  if (!cards[index]) return undefined
  let current = -1, seen = 0
  const stops = groupStops(cards, stopOf)
  stops.forEach((stop, i) => { if (index >= seen && index < seen + stop.cards.length) current = i; seen += stop.cards.length })
  const target = stops[current + step]
  return target && stopLanding(target, identity, memory)
}
