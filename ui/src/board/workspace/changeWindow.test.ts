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

it('marks hidden characters in place, keeps the text exact, and never hands them to the highlighter', async () => {
  const text = '  /*\u202e } \u2066if (isAdmin)\u2069 \u2066 begin */ {'
  const host = document.createElement('div'); document.body.append(host)
  const patch = `@@ -1 +1 @@\n+${text}\n`
  const mounted = mountChangeWindow(host, { ...window, patch, lines: [{ kind: 'addition', old: 0, new: 1, text }] }, file, { annotations: () => [], add() {}, field: () => document.createElement('div') })
  await mounted.ready
  expect(mocks.highlight).not.toHaveBeenCalled()
  expect(mocks.parse).not.toHaveBeenCalled()
  expect(host.dataset.renderState).toBe('plain')
  const rows = [...host.querySelectorAll('[data-line-text]')]
  expect(rows.map(row => row.textContent)).toEqual([text])
  expect([...rows[0].querySelectorAll<HTMLElement>('.change-hidden-char')].map(mark => mark.dataset.codepoint)).toEqual(['U+202E', 'U+2066', 'U+2069', 'U+2066'])
  expect(host.querySelector('[role="status"]')?.textContent).toContain('Hidden characters in evil.constructor')
  mounted.dispose()
})
it('marks hidden characters in a window with no structured rows', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const mounted = mountChangeWindow(host, { ...window, lines: undefined, patch: '+a\u202eb\n' }, file, { annotations: () => [], add() {}, field: () => document.createElement('div') })
  await mounted.ready
  expect(host.querySelector('pre')?.textContent).toBe('+a\u202eb\n')
  expect([...host.querySelectorAll<HTMLElement>('pre .change-hidden-char')].map(mark => mark.dataset.codepoint)).toEqual(['U+202E'])
  mounted.dispose()
})
