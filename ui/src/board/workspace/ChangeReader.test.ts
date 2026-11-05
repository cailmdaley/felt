// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { renderMarkdown } from '../utils.js'
import { mountChangeReader } from './ChangeReader.js'
import type { ChangeBundle } from './changeModel.js'

vi.mock('@pierre/diffs', () => ({ registerCustomCSSVariableTheme() {}, parsePatchFiles: () => [], FileDiff: class {} }))
vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} })
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
afterEach(() => { document.body.replaceChildren(); storage.clear() })
const hostile = '```js"onmouseover="alert(1) extra\ncode\n```\n<img src=x onerror=alert(1)>'

it('escapes hostile code info strings in untrusted Markdown', () => {
  const root = document.createElement('div')
  root.innerHTML = renderMarkdown(hostile, { untrusted: true })
  expect(root.querySelector('[onmouseover], [onerror], img')).toBeNull()
  expect(root.querySelector('code')?.className).toBe('language-jsonmouseoveralert1')
})

it('renders every story prose field through untrusted Markdown', () => {
  const bundle: ChangeBundle = { version: 1, title: 'Review', repo: { name: 'test', dir: '/repo', forge_url: null }, base: 'base', head: 'head', base_ref: 'main', head_ref: 'topic', commits: [], patch: '', files: [{ path: 'app.ts', role: 'implementation', status: 'modified', additions: 0, deletions: 0 }], story: { overview: hostile, flags: [{ file: 'app.ts', text: hostile }], chapters: [{ id: 'one', title: 'One', narrative: hostile, why_here: hostile, stops: [{ file: 'app.ts', note: hostile, importance: 'important' }] }] } }
  const root = document.createElement('div'); document.body.append(root)
  const mounted = mountChangeReader(root, bundle, 'test')
  expect(root.querySelectorAll('.change-prose code')).toHaveLength(4)
  expect(root.querySelector('[onmouseover], [onerror], img')).toBeNull()
  expect(root.querySelector('.change-why')?.textContent).toBe(hostile)
  mounted.dispose()
})
