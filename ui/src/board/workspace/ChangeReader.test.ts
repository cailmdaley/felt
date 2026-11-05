// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { renderMarkdown } from '../utils.js'
import { mountChangeReader } from './ChangeReader.js'
import type { ChangeBundle } from './changeModel.js'

vi.mock('@pierre/diffs', () => ({ registerCustomCSSVariableTheme() {}, parsePatchFiles: () => [], FileDiff: class {} }))
vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} })
const resized: (() => void)[] = []
vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized.push(callback) } observe() {} disconnect() {} })
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
afterEach(() => { document.body.replaceChildren(); storage.clear(); resized.length = 0 })
it('holds a navigation target through diff-window resizing until the reader scrolls deliberately', () => {
  const bundle: ChangeBundle = { version: 1, title: 'Review', repo: { name: 'test', dir: '/repo', forge_url: null }, base: 'base', head: 'head', base_ref: 'main', head_ref: 'topic', commits: [], files: [], story: null }
  const root = document.createElement('div'); document.body.append(root)
  const mounted = mountChangeReader(root, bundle, 'navigation')
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

const hostile = '```js"onmouseover="alert(1) extra\ncode\n```\n<img src=x onerror=alert(1)>'

it('escapes hostile code info strings in untrusted Markdown', () => {
  const root = document.createElement('div')
  root.innerHTML = renderMarkdown(hostile, { untrusted: true })
  expect(root.querySelector('[onmouseover], [onerror], img')).toBeNull()
  expect(root.querySelector('code')?.className).toBe('language-jsonmouseoveralert1')
})

it('renders every story prose field through untrusted Markdown', () => {
  const bundle: ChangeBundle = { version: 1, title: 'Review', repo: { name: 'test', dir: '/repo', forge_url: null }, base: 'base', head: 'head', base_ref: 'main', head_ref: 'topic', commits: [], files: [{ path: 'app.ts', role: 'generated', status: 'modified', additions: 0, deletions: 0, header: 'mode change', hunks: [], remaining: [] }], story: { overview: hostile, flags: [{ file: 'app.ts', text: hostile }], chapters: [{ id: 'one', title: 'One', narrative: hostile, why_here: hostile, stops: [{ file: 'app.ts', note: hostile, importance: 'important', hunks: [] }] }] } }
  const root = document.createElement('div'); document.body.append(root)
  const mounted = mountChangeReader(root, bundle, 'test')
  expect(root.querySelectorAll('.change-prose code')).toHaveLength(4)
  expect(root.querySelector('[onmouseover], [onerror], img')).toBeNull()
  expect(root.querySelector('.change-why')?.textContent).toBe(hostile)
  expect(root.querySelector('.change-file-head .change-role')?.textContent).toBe('generated · important')
  expect(root.querySelector('.change-metadata')?.textContent).toContain('no text hunks')
  const navigation = [...root.querySelectorAll('.change-contents button')].map(button => button.textContent)
  expect(navigation).toContain('Your review')
  expect(navigation).not.toContain('Your review  0/0')
  expect(navigation).toContain('Story  0/1')
  mounted.dispose()
})
