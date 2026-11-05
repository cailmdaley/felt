// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { mountChangeWindow, windowPatch } from './changeWindow.js'
import type { ChangeFile, ChangeWindow } from './changeModel.js'

const mocks = vi.hoisted(() => ({ parse: vi.fn(), highlight: vi.fn(), render: vi.fn(), cleanUp: vi.fn(), delayed: false, postRender: undefined as undefined | (() => void) }))
vi.mock('@pierre/diffs', () => ({
  parsePatchFiles: mocks.parse,
  getSharedHighlighter: mocks.highlight,
  FileDiff: class {
    constructor(options: { onPostRender: () => void }) {
      mocks.postRender = options.onPostRender
      this.render = (...args: unknown[]) => {
        mocks.render(...args)
        if (!mocks.delayed) options.onPostRender()
      }
    }
    render: (...args: unknown[]) => void
    cleanUp = mocks.cleanUp
  },
}))
afterEach(() => { vi.resetAllMocks(); mocks.delayed = false; document.body.replaceChildren() })
const window: ChangeWindow = { old_from: 1, old_lines: 1, new_from: 1, new_lines: 1, rows: 2, start: 0 }
const file: ChangeFile = {
  path: 'app.ts', status: 'modified', role: 'implementation', additions: 1, deletions: 1,
  header: 'diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n', hunks: [], remaining: [],
  lines: [{ kind: 'deletion', old: 1, new: 0, text: 'old' }, { kind: 'addition', old: 0, new: 1, text: 'new' }],
}
const comments = () => ({ annotations: () => [], add: vi.fn(), field: () => document.createElement('div') })

it('builds a patch only for the requested window', () => {
  expect(windowPatch(window, file)).toBe('diff --git "a/app.ts" "b/app.ts"\n--- "a/app.ts"\n+++ "b/app.ts"\n@@ -1,1 +1,1 @@\n-old\n+new\n')
})
it.each(['parse', 'grammar', 'render', 'empty render'])('retains readable rows after %s failure', async failure => {
  mocks.parse.mockReturnValue(failure === 'parse' ? [] : [{ files: [{}] }])
  mocks.highlight.mockResolvedValue({})
  if (failure === 'grammar') mocks.highlight.mockRejectedValue(new Error('stale grammar chunk'))
  if (failure === 'render') mocks.render.mockImplementation(() => { throw new Error('highlighting failed') })
  const host = document.createElement('div')
  document.body.append(host)
  const controls = comments()
  const mounted = mountChangeWindow(host, window, file, controls)
  expect(host.querySelectorAll('.change-plain-row')).toHaveLength(2)
  await mounted.ready
  expect(host.dataset.renderState).toBe('plain')
  if (failure !== 'parse') {
    expect(mocks.highlight).toHaveBeenCalledWith({
      langs: ['typescript'], themes: ['shuttle-change'], preferredHighlighter: 'shiki-wasm',
    })
  }
  expect([...host.querySelectorAll('[data-line-text]')].map(row => row.textContent)).toEqual(['old', 'new'])
  ;(host.querySelector('[aria-label="Comment on app.ts:1 (new)"]') as HTMLButtonElement).click()
  expect(controls.add).toHaveBeenCalledWith(1, 'additions')
  mounted.dispose()
  expect(host.childNodes).toHaveLength(0)
})
it('does not tokenize a huge window, or access rows outside the visible slice', async () => {
  const lines = [{ kind: 'addition' as const, old: 0, new: 1, text: 'x'.repeat(100_000) }]
  Object.defineProperty(lines, 1, { get() { throw new Error('offscreen row read') } })
  const host = document.createElement('div')
  const mounted = mountChangeWindow(host, { ...window, rows: 1 }, { ...file, lines }, comments())
  await mounted.ready
  expect(mocks.parse).not.toHaveBeenCalled()
  expect(mocks.highlight).not.toHaveBeenCalled()
  mounted.dispose()
  expect(host.childNodes).toHaveLength(0)
})
it('does not render after disposal while a grammar loads', async () => {
  let release!: () => void
  mocks.parse.mockReturnValue([{ files: [{}] }])
  mocks.highlight.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
  const host = document.createElement('div')
  const mounted = mountChangeWindow(host, window, file, comments())
  mounted.dispose()
  release()
  await mounted.ready
  expect(mocks.render).not.toHaveBeenCalled()
  expect(host.childNodes).toHaveLength(0)
})

it('waits for the rendered window, not just the grammar promise', async () => {
  mocks.delayed = true
  mocks.parse.mockReturnValue([{ files: [{}] }])
  mocks.highlight.mockResolvedValue({})
  const host = document.createElement('div')
  const mounted = mountChangeWindow(host, window, file, comments())
  let ready = false
  void mounted.ready.then(() => { ready = true })
  await vi.waitFor(() => expect(mocks.render).toHaveBeenCalled())
  expect(ready).toBe(false)
  mocks.postRender!()
  await mounted.ready
  expect(ready).toBe(true)
  mounted.dispose()
})
