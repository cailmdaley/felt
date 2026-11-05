// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mountChangeReader } from './ChangeReader.js'
import type { ChangeBundle } from './changeModel.js'

vi.mock('@pierre/diffs', () => ({ registerCustomCSSVariableTheme() {}, parsePatchFiles: () => [], FileDiff: class {}, getSharedHighlighter: vi.fn() }))
vi.stubGlobal('IntersectionObserver', class { callback: (entries: unknown[]) => void; constructor(callback: (entries: unknown[]) => void) { this.callback = callback } observe(target: Element) { this.callback([{ target, isIntersecting: true }]) } unobserve() {} disconnect() {} })
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
vi.stubGlobal('requestAnimationFrame', () => 1)
vi.stubGlobal('cancelAnimationFrame', () => {})
const storage = new Map<string, string>(), mounted: ReturnType<typeof mountChangeReader>[] = []
vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
beforeEach(() => storage.clear())
afterEach(() => { mounted.splice(0).forEach(reader => reader.dispose()); document.body.replaceChildren() })
function bundle(head = 'b'.repeat(40)): ChangeBundle {
  const hunk = { file: 'app.ts', old_from: 0, old_lines: 0, new_from: 1, new_lines: 1, patch: 'captured patch', windows: [{ old_from: 0, old_lines: 0, new_from: 1, new_lines: 1, patch: 'captured patch', rows: 1, lines: [{ kind: 'addition' as const, old: 0, new: 1, text: 'text' }] }] }
  return { version: 1, title: 'Review', repo: { name: 'r', dir: '/r', forge_url: null }, base: 'a'.repeat(40), head, base_ref: 'main', head_ref: 'head', commits: [], files: [{ path: 'app.ts', role: 'implementation', status: 'added', additions: 1, deletions: 0, old_mode: '000000', new_mode: '100644', header: '', hunks: [hunk], remaining: [hunk] }], story: null }
}
function mount(b: ChangeBundle, identity: string, send: (message: string) => Promise<void> = vi.fn(async (_message: string) => {})) {
  const root = document.createElement('div'); document.body.append(root)
  const reader = mountChangeReader(root, b, identity, send, () => true, () => 'work/holding on host-b'); mounted.push(reader)
  return { root, reader, send: vi.mocked(send) }
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
