// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import './ChronicleView'
import { getView, type ViewContext } from './ViewRegistry'
import type { CycleBand } from './ChronicleView'

const makeView = () => {
  const Constructor = getView('chronicle')!.constructor as new () => object
  return new Constructor() as {
    writeDue(id: string, origin: string, day: string, ctx: ViewContext): Promise<void>
    writeCycleEdge(band: CycleBand, edge: 'start' | 'due', day: string, ctx: ViewContext): Promise<void>
    dueEdits: Map<string, string>
    cycleEdits: Map<string, object>
    installDueMarkDrag(mark: HTMLElement, row: { cardId: string; dueIdx: number }, ctx: ViewContext): void
    installDrawToCreate(track: HTMLElement, ctx: ViewContext): void
    dayAt(track: HTMLElement, x: number): string | null
    draft: unknown
  }
}
afterEach(() => vi.unstubAllGlobals())

it('does not start a cycle draw when a due mark is pressed during a date write', async () => {
  let finish!: (value: Response) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
  const view = makeView()
  const ctx = { shuttleBase: 'https://board.example', requestRefresh: vi.fn() } as unknown as ViewContext
  const track = document.createElement('div')
  const mark = document.createElement('div')
  track.append(mark)
  vi.spyOn(view, 'dayAt').mockReturnValue('2026-12-01')
  view.installDrawToCreate(track, ctx)
  view.installDueMarkDrag(mark, { cardId: 'task', dueIdx: 0 }, ctx)
  const write = view.writeDue('task', 'owner', '2026-12-01', ctx)
  mark.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
  finish(new Response('{}'))
  await write
  expect(view.draft).toBeNull()
  expect(track.querySelector('.chr-band-ghost')).toBeNull()
  vi.restoreAllMocks()
})

it.each(['due', 'cycle'] as const)('holds all date writes for a fiber while its %s write is pending', async kind => {
  let reject!: (error: Error) => void
  const fetcher = vi.fn(() => new Promise<Response>((_resolve, fail) => { reject = fail }))
  vi.stubGlobal('fetch', fetcher)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const view = makeView()
  const ctx = { shuttleBase: 'https://board.example', requestRefresh: vi.fn() } as unknown as ViewContext
  const band = { id: 'task', originId: 'owner' } as CycleBand
  const first = kind === 'due'
    ? view.writeDue('task', 'owner', '2026-12-01', ctx)
    : view.writeCycleEdge(band, 'start', '2026-12-01', ctx)
  const second = view.writeCycleEdge(band, 'due', '2026-12-02', ctx)
  const third = view.writeDue('task', 'owner', '2026-12-03', ctx)
  expect(fetcher).toHaveBeenCalledTimes(1)
  reject(new Error('write refused'))
  await Promise.all([first, second, third])
  expect(view.dueEdits.size).toBe(0)
  expect(view.cycleEdits.size).toBe(0)
  // A failure releases the gate as well as removing its optimistic value.
  fetcher.mockResolvedValue(new Response('{}'))
  await view.writeDue('task', 'owner', '2026-12-04', ctx)
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(ctx.requestRefresh).toHaveBeenCalled()
  vi.restoreAllMocks()
})
