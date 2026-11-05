// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mountChangeReader } from './ChangeReader.js'
import type { ChangeBundle } from './changeModel.js'

vi.mock('@pierre/diffs', () => ({ registerCustomCSSVariableTheme() {}, disposeHighlighter() {}, parsePatchFiles: () => [], FileDiff: class {}, getSharedHighlighter: vi.fn() }))
vi.stubGlobal('IntersectionObserver', class { callback: (entries: unknown[]) => void; constructor(callback: (entries: unknown[]) => void) { this.callback = callback } observe(target: Element) { this.callback([{ target, isIntersecting: true }]) } unobserve() {} disconnect() {} })
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
const frames: FrameRequestCallback[] = []
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
vi.stubGlobal('cancelAnimationFrame', () => {})
const storage = new Map<string, string>(), mounted: ReturnType<typeof mountChangeReader>[] = []
vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
beforeEach(() => storage.clear())
afterEach(() => { mounted.splice(0).forEach(reader => reader.dispose()); document.body.replaceChildren(); frames.length = 0 })
function bundle(head = 'b'.repeat(40)): ChangeBundle {
  const hunk = { file: 'app.ts', old_from: 0, old_lines: 0, new_from: 1, new_lines: 1, windows: [{ old_from: 0, old_lines: 0, new_from: 1, new_lines: 1, rows: 1, start: 0 }] }
  return { version: 2, title: 'Review', repo: { name: 'r', dir: '/r', forge_url: null }, base: 'a'.repeat(40), head, base_ref: 'main', head_ref: 'head', commits: [], files: [{ path: 'app.ts', role: 'implementation', status: 'added', additions: 1, deletions: 0, old_mode: '000000', new_mode: '100644', header: '', lines: [{ kind: 'addition', old: 0, new: 1, text: 'text' }], hunks: [hunk], remaining: [hunk] }], story: null }
}
function mount(b: ChangeBundle, identity: string, send: (message: string) => Promise<void> = vi.fn(async (_message: string) => {})) {
  const root = document.createElement('div'); document.body.append(root)
  const reader = mountChangeReader(root, b, identity, 'source-revision', send, () => true, () => 'work/holding on host-b'); mounted.push(reader)
  return { root, reader, send: vi.mocked(send) }
}
function type(field: Element, text: string) { if (!(field instanceof HTMLTextAreaElement)) throw new Error('Expected a textarea'); field.value = text; field.dispatchEvent(new Event('input')) }
function lineComment(root: HTMLElement, text: string) {
  root.querySelector<HTMLButtonElement>('.change-plain-row [aria-label$="(new)"]')!.click()
  const field = [...root.querySelectorAll<HTMLTextAreaElement>('.change-draft-comments textarea')].at(-1)!
  type(field, text)
}

it('shows statuses, old paths, modes and type changes even for files with text hunks', () => {
  const b = bundle(), original = b.files[0]
  b.files = [
    original,
    { ...original, path: 'gone.ts', status: 'deleted' },
    { ...original, path: 'renamed.ts', status: 'renamed', old_path: 'source name.ts', old_mode: '100644', new_mode: '100644' },
    { ...original, path: 'run.sh', status: 'modified', old_mode: '100644', new_mode: '100755' },
    { ...original, path: 'link', status: 'modified', old_mode: '100644', new_mode: '120000' },
  ].map(file => ({ ...file, hunks: file.hunks.map(h => ({ ...h, file: file.path })), remaining: file.remaining.map(h => ({ ...h, file: file.path })) }))
  const { root } = mount(b, 'statuses')
  const statuses = [...root.querySelectorAll('.change-file-status')].map(node => node.textContent)
  expect(statuses[0]).toContain('added')
  expect(statuses[1]).toContain('deleted')
  expect(statuses[2]).toContain('renamed from source name.ts')
  expect(statuses[3]).toContain('mode change 100644 → 100755')
  expect(statuses[4]).toContain('type change 100644 → 120000')
})
it('counts and marks a role override but cannot mark a folded file viewed before opening it', () => {
  const b = bundle(); b.files[0].role = 'generated'; b.story = { overview: '', flags: [], chapters: [], roles: { 'app.ts': 'generated' } }
  const { root } = mount(b, 'folded')
  const details = root.querySelector<HTMLDetailsElement>('details.change-file')!, control = details.querySelector<HTMLButtonElement>('.change-viewed')!
  expect(details.querySelector('summary')?.textContent).toContain('1 changed line in file')
  expect(details.querySelector('.change-role')?.textContent).toBe('generated (role override)')
  expect(control.disabled).toBe(true); control.click(); expect(control.getAttribute('aria-pressed')).toBe('false')
  details.open = true; details.dispatchEvent(new Event('toggle'))
  expect(control.disabled).toBe(false); control.click(); expect(control.getAttribute('aria-pressed')).toBe('true')
})
it('keeps old draft anchors across rebakes, adds new anchors without mixing them, and resets viewed state', async () => {
  const first = mount(bundle(), 'rebake')
  type(first.root.querySelector('.change-overall')!, 'An overall note from the earlier head')
  lineComment(first.root, 'An earlier line comment')
  first.root.querySelector<HTMLButtonElement>('.change-viewed')!.click()
  first.reader.dispose()
  const next = mount(bundle('c'.repeat(40)), 'rebake')
  expect(next.root.querySelector<HTMLTextAreaElement>('.change-overall')?.value).toContain('earlier head')
  expect(next.root.querySelector('.change-comment label')?.textContent).toContain('head bbbbbbbb (earlier snapshot)')
  expect(next.root.querySelector('.change-viewed')?.getAttribute('aria-pressed')).toBe('false')
  lineComment(next.root, 'A comment on the rebaked head')
  expect(next.root.querySelectorAll('.change-draft-comments textarea')).toHaveLength(2)
  expect(next.root.querySelector('.change-send button')?.textContent).toContain('bbbbbbbb')
  expect(next.root.querySelector('.change-send')?.parentElement?.textContent).toContain('work/holding on host-b')
  next.root.querySelector<HTMLButtonElement>('.change-send button')!.click()
  await vi.waitFor(() => expect(next.send).toHaveBeenCalledOnce())
  const message = next.send.mock.calls[0][0]
  expect(message).toContain(`Head: ${'c'.repeat(40)}`)
  expect(message).toContain(`Earlier snapshot\nBase: ${'a'.repeat(40)}\nHead: ${'b'.repeat(40)}`)
  expect(message).toContain('An earlier line comment'); expect(message).toContain('A comment on the rebaked head')
  await vi.waitFor(() => expect(next.root.querySelector<HTMLTextAreaElement>('.change-overall')?.value).toBe(''))
})
it('keeps different-base comments independent and focuses the new anchor even at the same head', async () => {
  const first = mount(bundle(), 'new-base')
  lineComment(first.root, 'Old base matters too'); first.reader.dispose()
  const rebaked = bundle(); rebaked.base = 'd'.repeat(40)
  const next = mount(rebaked, 'new-base')
  expect(next.root.querySelector('.change-comment label')?.textContent).toContain('base aaaaaaaa, head bbbbbbbb (earlier snapshot)')
  expect(next.root.querySelector('.change-send')?.parentElement?.textContent).toContain('earlier snapshots (base aaaaaaaa, head bbbbbbbb)')
  lineComment(next.root, 'New base comment')
  frames.splice(0).forEach(callback => callback(0))
  const fields = [...next.root.querySelectorAll<HTMLTextAreaElement>('.change-draft-comments textarea')]
  expect(document.activeElement).toBe(fields[1])
  type(fields[0], 'Edited earlier-base comment'); expect(fields[1].value).toBe('New base comment')
  type(fields[1], 'Edited current-base comment'); expect(fields[0].value).toBe('Edited earlier-base comment')
  next.root.querySelector<HTMLButtonElement>('.change-send button')!.click()
  await vi.waitFor(() => expect(next.send).toHaveBeenCalledOnce())
  expect(next.send.mock.calls[0][0]).toContain(`Earlier snapshot\nBase: ${'a'.repeat(40)}\nHead: ${'b'.repeat(40)}\napp.ts:1\nEdited earlier-base comment`)
  expect(next.send.mock.calls[0][0]).toContain('app.ts:1\nEdited current-base comment')
})
it('unlocks a refused send without dropping its draft', async () => {
  const state = mount(bundle(), 'refused', vi.fn(async () => { throw new Error('Worker went away') }))
  type(state.root.querySelector('.change-overall')!, 'Keep this draft')
  state.root.querySelector<HTMLButtonElement>('.change-send button')!.click()
  await vi.waitFor(() => expect(state.root.querySelector('.change-send-status')?.textContent).toBe('Worker went away'))
  expect(state.root.querySelector<HTMLTextAreaElement>('.change-overall')?.value).toBe('Keep this draft')
  expect(state.root.querySelector<HTMLTextAreaElement>('.change-overall')?.disabled).toBe(false)
})
it('centers a flag on the requested plain row without syntax highlighting', async () => {
  const b = bundle()
  b.files[0].lines[0].text = 'x'.repeat(30_000)
  b.story = { overview: '', chapters: [], roles: {}, flags: [{ file: 'app.ts', from: 1, side: 'new', text: 'Here' }] }
  const { root, reader } = mount(b, 'plain-flag')
  const scroll = reader.scroller
  Object.defineProperty(scroll, 'clientHeight', { value: 600 })
  const box = (top: number) => ({ top, bottom: top + 20, height: 20 } as DOMRect)
  const host = root.querySelector<HTMLElement>('.change-diff-window')!
  const row = root.querySelector<HTMLElement>('.change-plain-row')!
  vi.spyOn(scroll, 'getBoundingClientRect').mockImplementation(() => box(0))
  vi.spyOn(host, 'getBoundingClientRect').mockImplementation(() => box(1000 - scroll.scrollTop))
  vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => box(1200 - scroll.scrollTop))
  root.querySelector<HTMLButtonElement>('.change-flag button')!.click()
  await vi.waitFor(() => expect(row.getBoundingClientRect().top).toBe(300))
})
