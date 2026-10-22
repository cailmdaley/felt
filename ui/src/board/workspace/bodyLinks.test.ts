// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { installWikilinks } from '../wikilinks.js'
import { constitutionMentions, mentionRuntime, bindConstitutionMentions, resolveConstitutionCandidates } from './bodyLinks.js'

const work = (extra = {}) => card({ id: 'work/child', uid: 'stable-child', name: 'Child', shuttleKind: 'oneshot', status: 'active', workerState: 'running', ...extra })
const index = [{ id: 'work/child', name: 'Child' }]
const update = (runtime: ReturnType<typeof mentionRuntime>, cards = [work()], candidates = ['[[child]]']) => {
  const rows = constitutionMentions(cards)
  runtime.update(rows, resolveConstitutionCandidates(candidates, rows, index).targets)
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren() })

describe('constitution mentions', () => {
  it('resolves wikilinks, exact paths and returned ids, preserving other links and unsafe near-matches', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>[[child]] <code>shuttle thread work/child "ask"</code> work/child, https://example/work/child /work/childish [[missing]] <a href="https://example.org">ordinary</a></p>'
    const open = vi.fn(), runtime = mentionRuntime(root, open)
    update(runtime, [work({ outcome: 'Verified result' })])
    // The path inside <code> stays code: copying the command yields the path.
    expect(root.querySelectorAll('.ws-constitution-chip')).toHaveLength(2)
    expect(root.querySelector('code')!.textContent).toBe('shuttle thread work/child "ask"')
    expect(root.textContent).toContain('https://example/work/child /work/childish [[missing]]')
    expect(root.querySelector('a[href="https://example.org"]')).not.toBeNull()
    const chip = root.querySelector<HTMLAnchorElement>('.ws-constitution-chip')!
    expect(chip.title).toContain('Verified result')
    chip.click(); expect(open).toHaveBeenCalledWith('work/child', work().originId)
    update(runtime, [work({ status: 'closed', workerState: undefined, outcome: 'Ready' })])
    expect(chip.textContent).toBe('Child · To review')
    expect(chip.title).toContain('Ready')
    runtime.dispose()
  })
  it('requires full-index wikilink resolution and does not guess ambiguous suffixes', () => {
    const root = document.createElement('div'); root.textContent = '[[child]] notes/plain'
    const runtime = mentionRuntime(root, vi.fn())
    const rows = constitutionMentions([work(), work({ id: 'other/child', uid: 'other' })])
    const resolved = resolveConstitutionCandidates(['[[child]]'], rows, [...index, { id: 'other/child', name: 'Child' }])
    runtime.update(rows, resolved.targets)
    expect(root.querySelectorAll('a')).toHaveLength(0)
    runtime.dispose()
  })
  it.each([true, false])('preserves ordinary exact wikilinks with a delayed index (install first: %s)', async installFirst => {
    const root = document.createElement('div'); root.innerHTML = '<div class="ws-prose-body"><a class="kbn-wikilink" data-fiber="child">child</a></div>'
    let finish!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const base = `http://mention-order-${installFirst}.invalid`
    let installing: Promise<void> | undefined
    const install = () => installWikilinks(root, { shuttleBase: base, onOpen: vi.fn() })
    if (installFirst) installing = install()
    const binding = bindConstitutionMentions(root, () => [work()], vi.fn(), { shuttleBase: base, frameActive: () => null })
    if (!installFirst) installing = install()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    finish(new Response(JSON.stringify({ fibers: [{ fiber: { id: 'child', name: 'Ordinary' } }, { fiber: { id: 'work/child', name: 'Child' } }] })))
    await installing
    await vi.waitFor(() => expect(root.querySelector('.kbn-wikilink-live')).not.toBeNull())
    expect(root.querySelector('.ws-constitution-chip')).toBeNull()
    expect(root.querySelector('a')!.dataset.fiber).toBe('child')
    binding.dispose()
  })
  it('resolves newly spawned read-model constitutions without waiting for a cached full index to include them', () => {
    const rows = constitutionMentions([work()])
    expect(resolveConstitutionCandidates(['[[work/child]]'], rows, []).rows).toEqual(rows)
    expect(resolveConstitutionCandidates(['[[child]]'], rows).rows).toStrictEqual([])
  })
  it('retains UID and origin across moves and never retargets a disappeared identity to reused paths', () => {
    const root = document.createElement('div'); root.textContent = 'work/child'
    const open = vi.fn(), runtime = mentionRuntime(root, open)
    update(runtime)
    const chip = root.querySelector<HTMLAnchorElement>('a')!
    update(runtime, [work({ id: 'work/renamed', status: 'closed' })])
    expect(chip.textContent).toBe('Child · To review')
    chip.click(); expect(open).toHaveBeenLastCalledWith('work/renamed', work().originId)
    update(runtime, [work({ uid: 'replacement', name: 'Different constitution' })])
    expect(chip.dataset.constitution).toBeUndefined()
    expect(chip.hasAttribute('href')).toBe(false)
    expect(chip.textContent).toBe('work/child')
    open.mockClear(); chip.click(); expect(open).not.toHaveBeenCalled()
    update(runtime, [work({ id: 'work/renamed', name: 'Returned' })])
    expect(chip.textContent).toBe('Returned · Working')
    runtime.dispose()
  })
  it('suppresses installed wikilink handlers when a retained constitution identity disappears', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ fibers: [{ fiber: { id: 'work/child', name: 'Child' } }] }))))
    const root = document.createElement('div'); root.innerHTML = '<a class="kbn-wikilink" data-fiber="work/child">work/child</a>'
    const ordinaryOpen = vi.fn(), constitutionOpen = vi.fn()
    await installWikilinks(root, { shuttleBase: 'http://missing-identity.invalid', onOpen: ordinaryOpen })
    const runtime = mentionRuntime(root, constitutionOpen)
    update(runtime, [work()], ['[[work/child]]'])
    const chip = root.querySelector<HTMLAnchorElement>('a')!
    expect(chip.dataset.constitutionIdentity).toBe('stable-child')
    update(runtime, [work({ uid: 'replacement' })])
    chip.click()
    chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(ordinaryOpen).not.toHaveBeenCalled()
    expect(constitutionOpen).not.toHaveBeenCalled()
    runtime.dispose()
  })
  it('chips a one-word id only as an explicit wikilink, never as a word, a filename, a domain or a URL', () => {
    const source = 'debug debug, [[debug]] debug.log debug.example.org https://example.test/?job=debug www.example.test/?job=debug mailto:debug'
    const root = document.createElement('div'); root.textContent = source
    const runtime = mentionRuntime(root, vi.fn())
    const rows = constitutionMentions([work({ id: 'debug', uid: 'debug-uid' })])
    runtime.update(rows, { '[[debug]]': 'debug-uid' })
    expect([...root.querySelectorAll<HTMLElement>('.ws-constitution-chip')].map(chip => chip.dataset.mentionSource)).toEqual(['[[debug]]'])
    expect(root.textContent).toContain('debug debug, ')
    expect(root.textContent).toContain('debug.log debug.example.org https://example.test/?job=debug www.example.test/?job=debug mailto:debug')
    runtime.dispose()
  })
  it('recognizes raw nested paths and ULIDs, without matching a one-word id in prose', () => {
    const root = document.createElement('div'); root.textContent = 'debug debugger debugged 01M5ETDH3XJH80QPYMZZNPNB9F work/child'
    const runtime = mentionRuntime(root, vi.fn())
    update(runtime, [work({ id: 'debug', uid: 'debug-uid' }), work({ uid: '01M5ETDH3XJH80QPYMZZNPNB9F' })])
    expect([...root.querySelectorAll<HTMLElement>('.ws-constitution-chip')].map(chip => chip.dataset.mentionSource)).toEqual(['01M5ETDH3XJH80QPYMZZNPNB9F', 'work/child'])
    expect(root.textContent).toContain('debug debugger debugged')
    runtime.dispose()
  })
  it('leaves code and preformatted blocks alone, and a constitution slugged "review" never chips the word', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>Please review this. <code>work/child</code></p><pre>shuttle thread work/child "ask"\n<span>work/child</span></pre><p>work/child</p>'
    const runtime = mentionRuntime(root, vi.fn())
    update(runtime, [work(), work({ id: 'review', uid: 'review-uid', name: 'Review' })])
    expect([...root.querySelectorAll('.ws-constitution-chip')].map(chip => chip.closest('p, pre')!.tagName)).toEqual(['P'])
    expect(root.querySelector('p')!.textContent).toBe('Please review this. work/child')
    expect(root.querySelector('pre')!.textContent).toBe('shuttle thread work/child "ask"\nwork/child')
    runtime.dispose()
  })
  it('names every lifecycle state from the board rules, including armed workers without runtime', () => {
    const states = [work(), work({ status: 'closed', workerState: undefined }),
      work({ status: 'open', effectiveHorizon: 'stashed', workerState: undefined }), work({ status: 'open', workerState: undefined }),
      work({ status: 'closed', tempered: true, workerState: undefined }), work({ ask: { text: 'Which?', at: '2026-01-01T00:00:00Z' } }), work({ workerState: undefined })]
    expect(constitutionMentions(states).map(row => row.state)).toEqual(['Working', 'To review', 'Resting', 'Drafts', 'Archived', 'Waiting', 'Working'])
  })
  it('sends only requested report metadata, resolves rows beyond 500, and enforces registration and active navigation', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"fibers":[]}')))
    const root = document.createElement('div'), frame = document.createElement('iframe'); root.append(frame); document.body.append(root)
    let registered = false, active = false
    const cards = Array.from({ length: 502 }, (_, i) => work({ id: `work/${i}`, uid: `uid-${i}`, outcome: `Private outcome ${i}` }))
    const open = vi.fn(), post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {})
    const binding = bindConstitutionMentions(root, () => cards, open, { shuttleBase: 'http://mentions-reports.invalid', frameActive: () => registered ? active : null })
    const emit = (data: object, source: Window = frame.contentWindow!) => window.dispatchEvent(new MessageEvent('message', { data: { protocol: 'shuttle-constitution-mentions', ...data }, source }))
    const request = (candidates: string[]) => emit({ type: 'candidates', candidates, reset: true, done: true })
    request(['work/501']); expect(post).not.toHaveBeenCalled()
    registered = true
    request([])
    expect(post.mock.lastCall?.[0].rows).toStrictEqual([])
    expect(JSON.stringify(post.mock.calls)).not.toContain('Private outcome')
    request(['work/501'])
    emit({ type: 'candidates', candidates: Array(1), reset: true, done: true })
    expect(() => binding.refresh()).not.toThrow()
    expect(post.mock.lastCall?.[0].rows.map((row: { id: string }) => row.id)).toEqual(['work/501'])
    expect(JSON.stringify(post.mock.lastCall)).not.toContain('Private outcome 0')
    const intent = { type: 'open', id: 'work/501', origin: work().originId }
    emit(intent); expect(open).not.toHaveBeenCalled()
    active = true
    emit(intent, window); expect(open).not.toHaveBeenCalled()
    emit({ ...intent, id: 'work/0' }); expect(open).not.toHaveBeenCalled()
    emit(intent); expect(open).toHaveBeenCalledWith('work/501', work().originId)
    binding.dispose()
  })
})
