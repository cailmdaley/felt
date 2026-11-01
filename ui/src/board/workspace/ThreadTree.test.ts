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
  expect(row(root.name).querySelector<HTMLElement>('.ws-tree-attention')?.dataset.state).toBe('waiting')
  expect(row(question.name).querySelector('.ws-tree-state')?.textContent).toBe('Waiting ?')
  expect(row(blocked.name).querySelector('.ws-tree-state')?.textContent).toBe('Waiting !')
  expect(row(dropped.name).querySelector('.ws-tree-state')?.textContent).toBe('Archived ×')
})
