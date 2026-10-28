// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { placeChildren } from './TranscriptBand.js'

it('places exactly the given children and never detaches one that stays', () => {
  const parent = document.createElement('div')
  const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(id => Object.assign(document.createElement('p'), { id }))
  parent.append(a, b, c, d)
  const moved: string[] = []
  new MutationObserver(records => { for (const r of records) for (const n of r.removedNodes) moved.push((n as Element).id) }).observe(parent, { childList: true })
  // b leaves from the middle, e arrives after c: a, c, d stay where they are.
  placeChildren(parent, [a, c, e, d])
  expect([...parent.children].map(n => n.id)).toStrictEqual(['a', 'c', 'e', 'd'])
  return Promise.resolve().then(() => expect(moved).toStrictEqual(['b']))
})
