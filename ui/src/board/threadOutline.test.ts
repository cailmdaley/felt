// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { card } from './testFixtures.js'
import { ThreadIndex, threadKey } from './threads.js'
import { threadRow } from './ThreadPeek.js'
import { renderOutline, outlineOpen, type Fold, type Outline } from './threadOutline.js'

const waiting = { status: 'active' as const, workerState: 'running' as const, runtimePhase: 'waiting' as const }
const working = { status: 'active' as const, workerState: 'running' as const, runtimePhase: 'working' as const }
const at = (n: number) => `2026-10-0${n}T00:00:00Z`
const root = card({ id: 'r', name: 'Root', ...working })
const asks = card({ id: 'r/a', name: 'Asks', orchestrator: 'r', createdAt: at(1), ...waiting })
const hub = card({ id: 'r/b', name: 'Hub', orchestrator: 'r', createdAt: at(2), ...working })
const deep = card({ id: 'r/b/1', name: 'Deep ask', orchestrator: 'r/b', createdAt: at(3), ...waiting })
const busy = card({ id: 'r/b/2', name: 'Busy', orchestrator: 'r/b', createdAt: at(4), ...working })
const draft = card({ id: 'r/c', name: 'Draft', orchestrator: 'r', createdAt: at(5), status: 'open' })
const parked = card({ id: 'r/d', name: 'Parked', orchestrator: 'r', createdAt: at(1), status: 'open', effectiveHorizon: 'stashed' })
const done = card({ id: 'r/e', name: 'Done', orchestrator: 'r', createdAt: at(6), status: 'closed', tempered: true })

function outline() {
  const index = new ThreadIndex([root, asks, hub, deep, busy, draft, parked, done]), folds = new Map<string, Fold>()
  const o: Outline = {
    index, root, current: root,
    needs: c => index.state(c) === 'waiting',
    fold: c => folds.get(threadKey(c)) ?? {},
    setFold: (c, fold) => folds.set(threadKey(c), fold),
    row: c => threadRow(c, index, vi.fn()),
  }
  const host = document.createElement('div')
  const draw = (): void => { host.replaceChildren(...outlineOpen(o) ? renderOutline(o, draw) : []) }
  draw()
  const shown = () => [...host.children].map(el => `${'  '.repeat(Number((el as HTMLElement).dataset.depth))}${el.matches('.kbn-thread-row') ? el.querySelector('.kbn-thread-name')!.textContent : el.textContent}`)
  const caret = (name: string) => [...host.querySelectorAll<HTMLElement>('.kbn-thread-row')].find(row => row.querySelector('.kbn-thread-name')!.textContent === name)!.querySelector<HTMLButtonElement>('button.kbn-thread-fold')!
  return { o, host, shown, caret, draw, folds }
}

it('opens on the way to what needs you, the rest behind a quiet count, and never the archived', () => {
  const { shown, host, o } = outline()
  expect(outlineOpen(o)).toBe(true)
  expect(shown()).toEqual(['Asks', 'Hub', '  Deep ask', '  1 more', '2 more'])
  host.querySelectorAll<HTMLButtonElement>('.kbn-thread-more')[1].click()
  // Every child at that level, those in play before the resting; still no archived thread.
  expect(shown()).toEqual(['Asks', 'Hub', '  Deep ask', '  1 more', 'Draft', 'Parked'])
})

it('folds each level on its own caret, remembers it, and a shut level reopens on what needs you', () => {
  const { shown, caret, host, o, folds } = outline()
  host.querySelector<HTMLButtonElement>('.kbn-thread-more')!.click()
  expect(shown()).toEqual(['Asks', 'Hub', '  Deep ask', '  Busy', '2 more'])
  caret('Hub').click()
  expect(caret('Hub').getAttribute('aria-expanded')).toBe('false')
  expect(shown()).toEqual(['Asks', 'Hub', '2 more'])
  caret('Hub').click()
  expect(shown()).toEqual(['Asks', 'Hub', '  Deep ask', '  1 more', '2 more'])
  // The whole family folds to its row.
  o.setFold(root, { collapsed: true })
  expect(outlineOpen(o)).toBe(false)
  expect(folds.get(threadKey(hub))).toEqual({ collapsed: false })
  expect(caret('Asks')?.matches('button')).toBeFalsy()
})

it('a family that asks nothing stays folded, and opens on every child at once', () => {
  const { o, shown, draw, caret } = outline()
  o.needs = () => false
  draw()
  expect(shown()).toEqual([])
  o.setFold(root, { collapsed: false })
  draw()
  expect(shown()).toEqual(['Asks', 'Hub', 'Draft', 'Parked'])
  caret('Hub').click()
  expect(shown()).toEqual(['Asks', 'Hub', '  Deep ask', '  Busy', 'Draft', 'Parked'])
})
