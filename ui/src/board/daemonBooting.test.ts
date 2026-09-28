import { afterEach, describe, expect, it } from 'vitest'
import { KanbanModal } from './KanbanModal.js'

interface FakeNode {
  className: string
  textContent: string
}

interface BootingBoard {
  deskEl: { innerHTML: string; append(node: FakeNode): void } | null
  markDaemonBooting(): void
}

describe('board booting state', () => {
  const originalDocument = globalThis.document
  afterEach(() => {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument })
  })

  it('shows a small starting message instead of a failed-load response', () => {
    const nodes: FakeNode[] = []
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: () => ({ className: '', textContent: '' }) },
    })

    const board = new KanbanModal({ shuttleBase: '' }) as unknown as BootingBoard
    board.deskEl = { innerHTML: 'old board', append: (node) => nodes.push(node) }
    board.markDaemonBooting()

    expect(board.deskEl.innerHTML).toBe('')
    expect(nodes).toEqual([{ className: 'kbn-error kbn-booting', textContent: 'daemon is starting…' }])
  })
})
