// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import type { FiberSend } from './fiberSends.js'
import { card, response } from './testFixtures.js'
import { DocumentSeen } from './workspace/DocumentSeen.js'
import { clearCardBodies } from './previewConstitution.js'
import type { Channel } from './workspace/documents.js'

function renderer(
  data: KanbanResponse,
  reports: Record<string, FiberSend> = {},
  sent: Record<string, FiberSend[]> = {},
  openCardDocument?: (card: KanbanCard, doc: string) => void,
): KanbanSurfaceRenderer {
  return new KanbanSurfaceRenderer(rendererOptions(data, reports, sent, openCardDocument))
}

function rendererOptions(
  data: KanbanResponse,
  reports: Record<string, FiberSend> = {},
  sent: Record<string, FiberSend[]> = {},
  openCardDocument?: (card: KanbanCard, doc: string) => void,
): ConstructorParameters<typeof KanbanSurfaceRenderer>[0] {
  return {
    getDragSourceId: () => null,
    setDragSourceId: () => {},
    getLastResponse: () => data,
    stopDragAutoScroll: () => {},
    transition: vi.fn(),
    setSurface: () => {},
    openDetail: () => {},
    onRest: () => {},
    onRefresh: () => {},
    getLatestReport: (c: KanbanCard) => reports[c.id],
    getSentFiles: (c: KanbanCard) => sent[c.id] ?? [],
    openCardDocument,
    shuttleBase: 'http://daemon',
  }
}

const REPORT: FiberSend = { key: 'local:/work/run/report.html', fullPath: '/work/run/report.html', basename: 'report.html', timestamp: Date.now() - 3 * 3_600_000, owner: 'local' }

const storage = new Map<string, string>()
beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) } })
  // A preview of a fiber that sent nothing reads its body; no daemon answers here.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no daemon') }))
  clearCardBodies()
})
afterEach(() => { document.body.replaceChildren(); storage.clear(); vi.unstubAllGlobals() })

describe('a Desk row is a line, not a card', () => {
  const review = card({
    id: 'work/run', name: 'Null tests on the reprocessed maps', status: 'closed', shuttleKind: 'oneshot',
    shuttleAgent: 'codex-sol', outcome: 'Ran the **comparison**; figures in report.html.', due: '2026-10-21',
  })
  const asked = card({
    id: 'asked', status: 'active', shuttleKind: 'oneshot', ask: { text: 'Which cut?', at: '2026-10-18T12:00:00Z' },
  })
  const data = response({ now: { drafts: [card({ id: 'draft', shuttleKind: 'oneshot', outcome: 'Plan it.' })], inFlight: [asked], awaitingReview: [review] } })

  it('carries the title and the glance facts, and nothing read', () => {
    const root = renderer(data, { 'work/run': REPORT }).renderNowSection(data.now, data.staleness)
    const row = root.querySelector<HTMLElement>('[data-fiber-id="work/run"]')!
    expect(row.querySelector('.kbn-card-name')?.textContent).toBe('Null tests on the reprocessed maps')
    // What a preview reads is not built for any row up front.
    for (const heavy of ['.kbn-card-outcome', '.kbn-card-id', '.kbn-card-question', '.kbn-card-actor', '.kbn-card-due', '.ws-thumbnail']) {
      expect(root.querySelector(heavy), heavy).toBeNull()
    }
    const mark = row.querySelector<HTMLElement>('.kbn-card-report')!
    expect(mark.dataset.kind).toBe('html')
    expect(mark.title).toMatch(/^report\.html — sent 3h ago$/)
    expect(root.querySelector('[data-fiber-id="draft"] .kbn-card-report')).toBeNull()
  })

  it('dots a report sent since the reader last showed it, until the reader shows it', () => {
    const mark = (): HTMLElement => renderer(data, { 'work/run': REPORT }).renderNowSection(data.now, data.staleness)
      .querySelector<HTMLElement>('[data-fiber-id="work/run"] .kbn-card-report')!
    // The first look sets the baseline: a report sent before it is not news.
    expect(mark().dataset.unseen).toBeUndefined()
    localStorage.setItem('shuttle.workspace.document-seen-baseline', String(REPORT.timestamp - 60_000))
    expect(mark().dataset.unseen).toBe('')
    expect(mark().getAttribute('aria-label')).toBe('New report: report.html')
    expect(mark().title).toMatch(/^report\.html — new, sent 3h ago$/)
    // The reader showing the report, in any session, clears the dot.
    const channel = { owner: 'local', uid: 'work/run', documents: [{ key: REPORT.key, provenance: [{ kind: 'sent', time: REPORT.timestamp }] }] } as unknown as Channel
    new DocumentSeen().observe(channel, REPORT.key)
    expect(mark().dataset.unseen).toBeUndefined()
  })

  it('keeps the verdicts and Rest at the row\'s right end, where an undo window lands', () => {
    const root = renderer(data).renderNowSection(data.now, data.staleness)
    const meta = root.querySelector<HTMLElement>('[data-fiber-id="work/run"] > .kbn-card-meta')!
    expect(meta.dataset.verdictKey).toBeTruthy()
    const actions = meta.querySelector(':scope > .kbn-card-hover-actions')!
    expect([...actions.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Temper', 'Discard', 'rest'])
  })
})

describe('the preview is the full card and what it sent, built for one row', () => {
  const review = card({
    id: 'work/run', uid: 'ULID-RUN', name: 'Null tests', status: 'closed', shuttleKind: 'oneshot',
    outcome: 'Ran the **comparison**.', due: '2026-10-21', mirroredOrigins: ['cluster'], originId: 'hub', shuttleHost: 'gpu-box',
  })
  const data = response({ now: { drafts: [], inFlight: [], awaitingReview: [review] } })
  const send = (name: string, hoursAgo: number): FiberSend =>
    ({ key: `hub:/work/run/${name}`, fullPath: `/work/run/${name}`, basename: name, timestamp: Date.now() - hoursAgo * 3_600_000, owner: 'hub' })
  const SENT = [send('report.html', 1), send('b-mode.png', 2), send('notes.pdf', 3), send('summary.md', 4), send('chains.tar.gz', 5), send('e-mode.png', 6)]
  const open = (surfaces: KanbanSurfaceRenderer) => {
    const root = surfaces.renderNowSection(data.now, data.staleness)
    return surfaces.buildCardPreview(root.querySelector<HTMLElement>('[data-card-uid="ULID-RUN"]')!)!
  }

  it('reads the outcome, path, machine, agent, due and where else the fiber lives', () => {
    const preview = open(renderer(data))
    expect(preview.el.querySelector('.kbn-card-name')?.textContent).toBe('Null tests')
    expect(preview.el.querySelector('.kbn-card-id')?.textContent).toBe('work/run')
    expect(preview.el.querySelector('.kbn-card-outcome strong')?.textContent).toBe('comparison')
    // The machine is the host the work runs on, ahead of every other fact.
    const facts = preview.el.querySelector('.kbn-preview-facts')!
    expect(facts.firstElementChild?.className).toBe('kbn-preview-host')
    expect(facts.firstElementChild?.textContent).toBe('gpu-box')
    // The full card names the agent even when it is the fleet default.
    expect(preview.el.querySelector('.kbn-card-actor')?.textContent).toBe('claude-opus')
    expect(preview.el.querySelector('.kbn-card-due')).not.toBeNull()
    expect(preview.el.textContent).toContain('also on cluster')
    expect(preview.el.dataset.column).toBe('awaitingReview')
    expect(preview.el.querySelector('.kbn-card')).toBeNull()
    expect(preview.el.querySelector('.kbn-preview-gallery')).toBeNull()
  })

  it('reads the constitution below the gallery, and makes what it embeds the cover', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ fibers: [{ origin: 'hub', path: 'work/run', felt_store: '/s', fiber: { id: 'work/run', name: 'Null tests', body: ':::{embed} report.html\n:title: The report\n:::\n\n## Desired State\n\nThe **null** passes.\n' } }] })))
    vi.stubGlobal('fetch', fetcher)
    const opened = vi.fn()
    const withDir = response({ now: { drafts: [], inFlight: [], awaitingReview: [{ ...review, fiberDir: '/store/.felt/work/run' }] } })
    const surfaces = renderer(withDir, {}, { 'work/run': [send('b-mode.png', 2)] }, opened)
    const root = surfaces.renderNowSection(withDir.now, withDir.staleness)
    const first = surfaces.buildCardPreview(root.querySelector<HTMLElement>('[data-card-uid="ULID-RUN"]')!)!
    const body = first.el.querySelector<HTMLElement>('.kbn-preview-body')!
    expect(body.textContent).toBe('Reading the constitution…')
    await vi.waitFor(() => expect(body.querySelector('.kbn-detail-prose h2')?.textContent).toBe('Desired State'))
    expect(body.querySelector('.kbn-detail-prose strong')?.textContent).toBe('null')
    expect(String((fetcher.mock.calls[0] as unknown[])[0])).toMatch(/\/api\/v1\/fibers\/work\/run\?body=true&origin=hub/)
    // The embed leads the gallery as its cover, beside what was sent; the body follows.
    const items = [...first.el.querySelectorAll<HTMLElement>('.kbn-preview-gallery .kbn-preview-send')]
    expect(items.map(i => [i.querySelector('.kbn-preview-send-name')?.textContent, i.dataset.slot])).toEqual([['report.html', 'cover'], ['b-mode.png', 'plate']])
    expect(items[0].querySelector('.kbn-preview-send-age')?.textContent).toBe('in the body')
    expect(first.el.querySelector('.kbn-preview-gallery')!.nextElementSibling).toBe(body)
    items[0].click()
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ id: 'work/run' }), 'hub:/store/.felt/work/run/report.html')
    // Read once per card.
    surfaces.buildCardPreview(root.querySelector<HTMLElement>('[data-card-uid="ULID-RUN"]')!)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('names the host that serves a card nothing runs', () => {
    const human = card({ id: 'note', uid: 'ULID-NOTE', originId: 'hub', shuttleKind: undefined })
    const only = response({ now: { drafts: [human], inFlight: [], awaitingReview: [] } })
    const surfaces = renderer(only)
    const root = surfaces.renderNowSection(only.now, only.staleness)
    const preview = surfaces.buildCardPreview(root.querySelector<HTMLElement>('[data-card-uid="ULID-NOTE"]')!)!
    expect(preview.el.querySelector('.kbn-preview-host')?.textContent).toBe('hub')
  })

  it('lays out every sent file newest first: a cover, plots at full width, tiles and lines', () => {
    const preview = open(renderer(data, {}, { 'work/run': SENT }))
    const items = [...preview.el.querySelectorAll<HTMLElement>('.kbn-preview-gallery .kbn-preview-send')]
    expect(items.map(i => [i.querySelector('.kbn-preview-send-name')?.textContent, i.dataset.slot])).toEqual([
      ['report.html', 'cover'], ['b-mode.png', 'plate'], ['notes.pdf', 'tile'], ['summary.md', 'tile'], ['chains.tar.gz', 'line'], ['e-mode.png', 'plate'],
    ])
    // Pages and text share a row of tiles; a receipt has no thumbnail.
    expect(preview.el.querySelector('.kbn-preview-tiles')?.children).toHaveLength(2)
    expect(items[4].querySelector('.ws-thumbnail')).toBeNull()
    expect(items[0].querySelector('.kbn-preview-send-age')?.textContent).toBe('1h ago')
  })

  it('opens a sent file in its fiber\'s channel', () => {
    const opened = vi.fn()
    const preview = open(renderer(data, {}, { 'work/run': SENT }, opened))
    preview.el.querySelectorAll<HTMLElement>('.kbn-preview-send')[1].click()
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ id: 'work/run' }), SENT[1].key)
  })

  it('repaints the card in place on a redraw and keeps the gallery, unless what it sent changed', () => {
    const sent: Record<string, FiberSend[]> = { 'work/run': SENT.slice(0, 2) }
    const surfaces = renderer(data, {}, sent)
    const root = surfaces.renderNowSection(data.now, data.staleness)
    const preview = surfaces.buildCardPreview(root.querySelector<HTMLElement>('[data-card-uid="ULID-RUN"]')!)!
    const gallery = preview.el.querySelector('.kbn-preview-gallery')
    const redrawn = surfaces.renderNowSection(data.now, data.staleness).querySelector<HTMLElement>('[data-card-uid="ULID-RUN"]')!
    expect(preview.refresh?.(redrawn)).toBe(true)
    expect(preview.el.querySelector('.kbn-preview-gallery')).toBe(gallery)
    expect(preview.el.querySelectorAll('.kbn-preview-card')).toHaveLength(1)
    sent['work/run'] = SENT.slice(0, 3)
    expect(preview.refresh?.(redrawn)).toBe(false)
  })

  it('releases its thumbnails on dispose', () => {
    const preview = open(renderer(data, {}, { 'work/run': SENT }))
    const thumb = preview.el.querySelector<HTMLElement>('.ws-thumbnail')!
    document.body.append(preview.el)
    preview.dispose?.()
    expect(thumb.isConnected).toBe(false)
  })

  it('answers null for a row whose card has left the response', () => {
    const stray = document.createElement('div')
    stray.dataset.cardUid = 'gone'
    stray.dataset.cardOrigin = 'local'
    expect(renderer(data).buildCardPreview(stray)).toBeNull()
  })
})

describe('a Resting line takes its verdicts', () => {
  const resting = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>) => card({ status: 'open', effectiveHorizon: 'stashed', storedHorizon: 'stashed', ...over })
  const once = resting({ id: 'once', uid: 'U-ONCE', shuttleKind: 'oneshot' })
  const standing = resting({ id: 'standing', uid: 'U-STAND', shuttleKind: 'standing', status: 'active', shuttleSchedule: '0 8 * * *' })
  const todo = resting({ id: 'todo', uid: 'U-TODO' })
  const data = response({ stash: [once, standing, todo] })
  const labels = (root: HTMLElement, id: string): string[] =>
    [...root.querySelectorAll(`[data-fiber-id="${id}"] .kbn-cluster-item-verdicts button`)].map(b => b.textContent ?? '')

  it('offers Temper and Discard on a constitution at rest, Discard alone on a standing one, none on a plain note', () => {
    const root = renderer(data).renderStashSection(data.stash, {})
    expect(labels(root, 'once')).toEqual(['Temper', 'Discard'])
    expect(labels(root, 'standing')).toEqual(['Discard'])
    expect(labels(root, 'todo')).toEqual([])
    // The undo window waits on the line, where the verdict was given.
    expect(root.querySelector<HTMLElement>('[data-fiber-id="once"] .kbn-cluster-item-verdicts')?.dataset.verdictKey).toBeTruthy()
  })

  it('sends the verdict through the board\'s transition, without opening the card', () => {
    const transition = vi.fn()
    const openDetail = vi.fn()
    const surfaces = new KanbanSurfaceRenderer({ ...rendererOptions(data), transition, openDetail })
    const root = surfaces.renderStashSection(data.stash, {})
    root.querySelector<HTMLElement>('[data-fiber-id="once"] .kbn-action-discard')!.click()
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ id: 'once' }), 'composted')
    expect(openDetail).not.toHaveBeenCalled()
  })

  it('offers the same verdicts in the preview\'s head', () => {
    const surfaces = renderer(data)
    const root = surfaces.renderStashSection(data.stash, {})
    const head = (id: string) => [...surfaces.buildCardPreview(root.querySelector<HTMLElement>(`[data-fiber-id="${id}"]`)!)!
      .el.querySelectorAll('.kbn-preview-verdicts button')].map(b => b.textContent)
    expect(head('once')).toEqual(['Temper', 'Discard'])
    expect(head('standing')).toEqual(['Discard'])
    expect(head('todo')).toEqual([])
  })
})
