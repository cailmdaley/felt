// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { mountChangeReader } from './ChangeReader.js'
import type { ChangeBundle } from './changeModel.js'

vi.mock('@pierre/diffs', () => ({ registerCustomCSSVariableTheme() {}, disposeHighlighter() {}, parsePatchFiles: () => [], FileDiff: class {} }))
vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} })
const resized: (() => void)[] = []
vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized.push(callback) } observe() {} disconnect() {} })
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
afterEach(() => { document.body.replaceChildren(); storage.clear(); resized.length = 0 })
it('holds a navigation target through diff-window resizing until the reader scrolls deliberately', () => {
  const bundle: ChangeBundle = { version: 2, title: 'Review', repo: { name: 'test', dir: '/repo', forge_url: null }, base: 'a'.repeat(40), head: 'b'.repeat(40), base_ref: 'main', head_ref: 'topic', commits: [], files: [], story: null }
  const root = document.createElement('div'); document.body.append(root)
  const mounted = mountChangeReader(root, bundle, 'navigation', 'source-revision')
  const target = [...root.querySelectorAll<HTMLElement>('.change-section')].at(-1)!
  let absoluteTop = 1000
  vi.spyOn(target, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, absoluteTop - mounted.scroller.scrollTop, 100, 100))
  const link = [...root.querySelectorAll<HTMLButtonElement>('.change-contents button')].find(button => button.textContent === 'Your review')!
  link.click()
  expect(mounted.scroller.scrollTop).toBe(984)
  absoluteTop = 2000
  resized.forEach(callback => callback())
  expect(mounted.scroller.scrollTop).toBe(1984)
  mounted.scroller.dispatchEvent(new Event('wheel', { bubbles: true }))
  absoluteTop = 3000
  resized.forEach(callback => callback())
  expect(mounted.scroller.scrollTop).toBe(1984)
  mounted.dispose()
})

it('renders the story prose and keeps metadata readable', () => {
  const prose = 'A **useful** reading order with `code`.'
  const bundle: ChangeBundle = { version: 2, title: 'Review', repo: { name: 'test', dir: '/repo', forge_url: null }, base: 'a'.repeat(40), head: 'b'.repeat(40), base_ref: 'main', head_ref: 'topic', commits: [], files: [{ path: 'app.ts', role: 'generated', status: 'modified', additions: 0, deletions: 0, header: 'mode change', lines: [], hunks: [], remaining: [] }], story: { overview: prose, flags: [{ file: 'app.ts', text: prose }], chapters: [{ id: 'one', title: 'One', narrative: prose, why_here: 'Read this first.', stops: [{ file: 'app.ts', note: prose, importance: 'important', hunks: [] }] }] } }
  const root = document.createElement('div'); document.body.append(root)
  const mounted = mountChangeReader(root, bundle, 'test', 'source-revision')
  expect(root.querySelectorAll('.change-prose code')).toHaveLength(4)
  expect(root.querySelectorAll('.change-prose strong')).toHaveLength(4)
  expect(root.querySelector('.change-why')?.textContent).toBe('Read this first.')
  expect(root.querySelector('.change-file-head .change-role')?.textContent).toBe('generated · important')
  expect(root.querySelector('.change-metadata')?.textContent).toContain('no text hunks')
  const navigation = [...root.querySelectorAll('.change-contents button')].map(button => button.textContent)
  expect(navigation).toContain('Your review')
  expect(navigation).not.toContain('Your review  0/0')
  expect(navigation).toContain('Story  0/1')
  mounted.dispose()
})

it('opening a 103-file change never reads offscreen source rows', () => {
  const bundle: ChangeBundle = {
    version: 2, title: 'Large change', repo: { name: 'test', dir: '/repo', forge_url: null },
    base: 'a'.repeat(40), head: 'b'.repeat(40), base_ref: 'main', head_ref: 'topic', commits: [], story: null,
    files: Array.from({ length: 103 }, (_, index) => ({
      path: `file-${index}.ts`, role: 'implementation', status: 'added', additions: 130, deletions: 0, header: '',
      lines: new Proxy([], { get(): never { throw new Error('Offscreen source was read') } }),
      hunks: [{ file: `file-${index}.ts`, old_from: 0, old_lines: 0, new_from: 1, new_lines: 130,
        windows: [{ old_from: 0, old_lines: 0, new_from: 1, new_lines: 130, start: 0, rows: 130 }] }],
      remaining: [{ file: `file-${index}.ts`, old_from: 0, old_lines: 0, new_from: 1, new_lines: 130,
        windows: [{ old_from: 0, old_lines: 0, new_from: 1, new_lines: 130, start: 0, rows: 130 }] }],
    })),
  }
  const root = document.createElement('div')
  document.body.append(root)
  const mounted = mountChangeReader(root, bundle, 'large', 'source-revision')
  expect(root.querySelector('h1')?.textContent).toBe('Large change')
  expect(root.querySelectorAll('.change-diff-window')).toHaveLength(103)
  mounted.dispose()
  expect(root.childNodes).toHaveLength(0)
})
