// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { mountChangeWindow } from './changeWindow.js'
import type { ChangeFile, ChangeWindow } from './changeModel.js'

const mocks = vi.hoisted(() => ({ parse: vi.fn(), highlight: vi.fn(), render: vi.fn() }))
vi.mock('@pierre/diffs', () => ({ parsePatchFiles: mocks.parse, getSharedHighlighter: mocks.highlight, FileDiff: class { render = mocks.render; cleanUp() {} } }))
afterEach(() => { vi.resetAllMocks(); document.body.replaceChildren() })
const window: ChangeWindow = { old_from: 1, old_lines: 1, new_from: 1, new_lines: 1, rows: 2, patch: 'patch', lines: [{ kind: 'deletion', old: 1, new: 0, text: 'old' }, { kind: 'addition', old: 0, new: 1, text: '<img src=x onerror=evil()>' }] }
const file: ChangeFile = { path: 'evil.constructor', status: 'modified', role: 'implementation', additions: 1, deletions: 1, header: '', hunks: [], remaining: [] }
it.each(['parse', 'grammar', 'render', 'empty render'])('retains plain DOM rows after %s failure', async failure => {
  mocks.parse.mockReturnValue(failure === 'parse' ? [] : [{ files: [{}] }])
  if (failure === 'grammar') mocks.highlight.mockRejectedValue(new Error('stale grammar chunk'))
  else mocks.highlight.mockResolvedValue({})
  if (failure === 'render') mocks.render.mockImplementation(() => { throw new Error('highlighting failed') })
  const host = document.createElement('div'); document.body.append(host)
  const add = vi.fn(), mounted = mountChangeWindow(host, window, file, { annotations: () => [], add, field: () => document.createElement('div') })
  expect(host.querySelectorAll('.change-plain-row')).toHaveLength(2)
  await mounted.ready
  expect(host.dataset.renderState).toBe('plain')
  expect((host.querySelector('.change-plain-window') as HTMLElement).hidden).toBe(false)
  expect([...host.querySelectorAll('[data-line-text]')].map(row => row.textContent)).toEqual(['old', '<img src=x onerror=evil()>'])
  expect(host.querySelector('img')).toBeNull()
  expect(host.querySelector('[role="status"]')?.textContent).toContain(file.path)
  ;(host.querySelector('[aria-label="Comment on evil.constructor:1 (new)"]') as HTMLButtonElement).click()
  expect(add).toHaveBeenCalledWith(1, 'additions')
  mounted.dispose(); expect(host.childNodes).toHaveLength(0)
})
it('names a file visibly when no structured rows or parse result can be rendered', async () => {
  mocks.parse.mockReturnValue([])
  const host = document.createElement('div')
  const mounted = mountChangeWindow(host, { ...window, lines: undefined }, file, { annotations: () => [], add() {}, field: () => document.createElement('div') })
  await mounted.ready
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not render evil.constructor')
  expect(host.querySelector('pre')?.textContent).toBe('patch')
  mounted.dispose()
})
