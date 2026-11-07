// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { ThreadIndex } from '../threads.js'
import { threadRow } from '../ThreadPeek.js'
import { renderThreadTree } from './ThreadTree.js'

it('names each row state and distinguishes question, blocked and discarded', () => {
  const root = card({ id: 'root', status: 'active', workerState: 'running', runtimePhase: 'working' })
  const question = card({ id: 'question', orchestrator: root.id, status: 'active', ask: { text: 'Which?', at: '2026-01-01T00:00:00Z' } })
  const blocked = card({ id: 'blocked', orchestrator: root.id, status: 'active', workerState: 'blocked' })
  const dropped = card({ id: 'dropped', orchestrator: root.id, status: 'closed', tempered: false })
  const index = new ThreadIndex([root, question, blocked, dropped]), container = document.createElement('div')
  container.append(...renderThreadTree(index, root, root, c => threadRow(c, index, vi.fn())))
  const row = (name: string) => [...container.querySelectorAll<HTMLElement>('.kbn-thread-row')].find(el => el.querySelector('.kbn-thread-name')?.textContent === name)!
  expect(row(root.name).querySelector('.ws-tree-state')?.textContent).toBe('Working')
  expect(container.querySelector('.ws-tree-attention')).toBeNull()
  expect(row(question.name).getAttribute('aria-label')).toBe('question, Waiting, Your question')
  expect(row(question.name).getAttribute('aria-level')).toBe('2')
  expect(row(question.name).querySelector('[title="Your question"]')?.textContent).toBe(' ?')
  expect(row(blocked.name).querySelector('[title="Blocked"]')?.textContent).toBe(' !')
  expect(row(dropped.name).querySelector('[title="Discarded"]')?.textContent).toBe(' ×')
  expect(row(question.name).querySelector('.ws-tree-state')?.textContent).toBe('Waiting ?')
  expect(row(blocked.name).querySelector('.ws-tree-state')?.textContent).toBe('Waiting !')
  expect(row(dropped.name).querySelector('.ws-tree-state')?.textContent).toBe('Archived ×')
})

it('keeps a waiting descendant visible beneath its archived ancestor', () => {
  const root = card({ id: 'root' }), archived = card({ id: 'old', orchestrator: 'root', status: 'closed', tempered: true }),
    waiting = card({ id: 'ask', orchestrator: 'old', status: 'active', ask: { text: 'Which?', at: '2026-01-01T00:00:00Z' } }),
    quiet = card({ id: 'quiet', orchestrator: 'root', status: 'closed', tempered: true })
  const index = new ThreadIndex([root, archived, waiting, quiet]), container = document.createElement('div')
  container.append(...renderThreadTree(index, root, root, c => threadRow(c, index, vi.fn())))
  const ask = container.querySelector<HTMLElement>('[data-card-uid="ask"]')!
  expect(ask.closest('details:not([open])')).toBeNull()
  expect(ask.getAttribute('aria-level')).toBe('3')
  expect(container.querySelector<HTMLElement>('[data-card-uid="old"]')!.closest('details:not([open])')).toBeNull()
  expect(container.querySelector<HTMLDetailsElement>('details')!.open).toBe(false)
})

it('opens a disclosure when the current thread becomes archived without navigating', () => {
  const root = card({ id: 'root' }), current = card({ id: 'child', orchestrator: 'root', status: 'active' })
  const index = new ThreadIndex([root, { ...current, status: 'closed', tempered: true }]), container = document.createElement('div')
  container.append(...renderThreadTree(index, root, current, c => threadRow(c, index, vi.fn())))
  const fold = container.querySelector<HTMLDetailsElement>('details')!
  expect(fold.open).toBe(true)
  expect(fold.querySelector('[aria-current="page"] .kbn-thread-name')?.textContent).toBe('child')
})

it('draws threads in play as the tree, then the resting, then the archived below it', () => {
  const root = card({ id: 'root', status: 'active' })
  const working = card({ id: 'working', orchestrator: 'root', status: 'active', createdAt: '2026-11-01T10:00:00Z' })
  const parked = card({ id: 'parked', orchestrator: 'root', status: 'open', effectiveHorizon: 'stashed', createdAt: '2026-11-01T09:00:00Z' })
  const done = card({ id: 'done', orchestrator: 'root', status: 'closed', tempered: true, createdAt: '2026-11-01T08:00:00Z' })
  const index = new ThreadIndex([root, working, parked, done]), container = document.createElement('div')
  container.append(...renderThreadTree(index, root, root, c => threadRow(c, index, vi.fn())))
  const order = [...container.querySelectorAll<HTMLElement>('.kbn-thread-row, summary')].map(el => el.matches('summary') ? el.textContent : el.dataset.cardUid)
  expect(order).toEqual(['root', 'working', '1 resting', 'parked', '1 archived', 'done'])
  const [resting, archived] = container.querySelectorAll<HTMLDetailsElement>('details')
  expect([resting.open, archived.open]).toEqual([true, false])
})
