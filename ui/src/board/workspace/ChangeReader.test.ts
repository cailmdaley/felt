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
const modeOnly = { path: 'app.ts', role: 'implementation' as const, status: 'modified', additions: 0, deletions: 0, header: 'mode change', lines: [], hunks: [], remaining: [] }
it('holds a navigation target through diff-window resizing until the reader scrolls deliberately', () => {
  const bundle: ChangeBundle = { version: 2, title: 'Review', repo: { name: 'test', dir: '/repo', forge_url: null }, base: 'a'.repeat(40), head: 'b'.repeat(40), base_ref: 'main', head_ref: 'topic', commits: [], files: [modeOnly], story: null }
  const root = document.createElement('div'); document.body.append(root)
  const mounted = mountChangeReader(root, bundle, 'navigation', 'source-revision')
  const target = [...root.querySelectorAll<HTMLElement>('.change-section')].at(-1)!
  let absoluteTop = 1000
  vi.spyOn(target, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, absoluteTop - mounted.scroller.scrollTop, 100, 100))
  const link = [...root.querySelectorAll<HTMLButtonElement>('.change-contents button')].find(button => button.textContent?.startsWith('Remaining'))!
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
  const stop = root.querySelector<HTMLDetailsElement>('.change-file')!
  expect(stop.open).toBe(false)
  const note = root.querySelector<HTMLElement>('.change-stop-note')!
  expect(note.textContent).toBeTruthy()
  expect(note.closest('summary, details')).toBeNull()
  note.click()
  expect(stop.open).toBe(false)
  const viewed = root.querySelector<HTMLButtonElement>('.change-stop-intro .change-viewed')!
  expect(viewed.disabled).toBe(false)
  viewed.click()
  expect(viewed.textContent).toContain('Viewed')
  expect(stop.open).toBe(false)
  expect(root.querySelector('.change-diff-window')).toBeNull()
  viewed.click()
  expect(viewed.textContent).toBe('Mark viewed')
  expect(stop.open).toBe(false)
  stop.open = true
  stop.dispatchEvent(new Event('toggle'))
  expect(root.querySelector('.change-metadata')?.textContent).toContain('no text hunks')
  const navigation = [...root.querySelectorAll('.change-contents button')].map(button => button.textContent)
  expect(root.querySelector('.change-review-dock .change-send')).not.toBeNull()
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
  expect(root.querySelectorAll('.change-diff-window')).toHaveLength(0)
  expect(root.querySelectorAll('details.change-file:not([open])')).toHaveLength(103)
  mounted.dispose()
  expect(root.childNodes).toHaveLength(0)
})

it('opens a story-less change on its own description, above the note that no story is authored', () => {
  const bundle: ChangeBundle = { version: 2, title: 'Review', description: '**Topic subject**\n\nWhy the `topic` exists.', repo: { name: 'test', dir: '/repo', forge_url: null }, base: 'a'.repeat(40), head: 'b'.repeat(40), base_ref: 'origin/main', head_ref: 'topic', commits: [], files: [modeOnly], story: null }
  const root = document.createElement('div'); document.body.append(root)
  const mounted = mountChangeReader(root, bundle, 'description', 'source-revision')
  const opening = root.querySelector('.change-opening')!
  expect(opening.querySelector('.change-prose strong')?.textContent).toBe('Topic subject')
  expect(opening.querySelector('.change-prose code')?.textContent).toBe('topic')
  const note = [...root.querySelectorAll('.change-main > .change-section-note')].find(p => p.textContent?.startsWith('No authored story'))!
  expect(opening.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  mounted.dispose()

  const storied = mountChangeReader(root, { ...bundle, story: { overview: 'The *story* leads.', flags: [], chapters: [] } }, 'storied', 'source-revision')
  expect(root.querySelector('.change-opening')?.textContent?.trim()).toBe('The story leads.')
  storied.dispose()
})

it('says in one sentence that a change has no changes, naming branch, base and head', () => {
  const bundle: ChangeBundle = { version: 2, title: 'Review', repo: { name: 'test', dir: '/repo', forge_url: null }, base: 'a'.repeat(40), head: 'b'.repeat(40), base_ref: 'origin/main', head_ref: 'topic', commits: [], files: [], story: null }
  const root = document.createElement('div'); document.body.append(root)
  const mounted = mountChangeReader(root, bundle, 'empty', 'source-revision')
  expect(root.textContent).toBe('No changes: topic bbbbbbbb has the same files as its merge base with origin/main aaaaaaaa.')
  expect(mounted.scroller.isConnected).toBe(true)
  mounted.dispose()
  expect(root.childElementCount).toBe(0)
})
