// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal.js'
import type { WorkerOpener } from './conversationOpening.js'

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren() })

it("hands the band's opener the worker's past session, which the daemon reopens when the terminal has gone", () => {
  vi.useFakeTimers()
  const onOpenWorker = vi.fn<WorkerOpener>()
  const board = new KanbanModal({ shuttleBase: '', onOpenWorker }) as unknown as { openWorkerAfterGesture: WorkerOpener }
  board.openWorkerAfterGesture('unions-shuttle', 'fir', 'd0031eb4-812b-4d5d-b0b8-eaae68886bbb')
  vi.runAllTimers()
  expect(onOpenWorker).toHaveBeenCalledWith('unions-shuttle', 'fir', 'd0031eb4-812b-4d5d-b0b8-eaae68886bbb')
})
