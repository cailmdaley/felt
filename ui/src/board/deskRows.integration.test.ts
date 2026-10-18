// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import type { LatestReport } from './latestReports.js'
import { card, response } from './testFixtures.js'
import { DocumentSeen } from './workspace/DocumentSeen.js'
import type { Channel } from './workspace/documents.js'

function renderer(data: KanbanResponse, reports: Record<string, LatestReport> = {}): KanbanSurfaceRenderer {
  return new KanbanSurfaceRenderer({
    getDragSourceId: () => null,
    setDragSourceId: () => {},
    getLastResponse: () => data,
    stopDragAutoScroll: () => {},
    transition: vi.fn(),
    setSurface: () => {},
    stack: () => {},
    reorderQueue: () => {},
    unqueueRow: () => {},
    openDetail: () => {},
    onRest: () => {},
    onRefresh: () => {},
    getLatestReport: (c: KanbanCard) => reports[c.id],
    shuttleBase: 'http://daemon',
  })
}

const REPORT: LatestReport = { key: 'local:/work/run/report.html', fullPath: '/work/run/report.html', basename: 'report.html', timestamp: Date.now() - 3 * 3_600_000, owner: 'local' }

const storage = new Map<string, string>()
beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) } })
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

  it('hangs a queue\'s peek list under the row, on a line of its own', () => {
    const head = card({ id: 'head', shuttleKind: 'oneshot' })
    const behind = card({ id: 'behind', shuttleKind: 'oneshot', dependsOn: ['head'], dependsOnShape: 'scalar', effectiveHorizon: 'stashed' })
    const queued = response({ now: { drafts: [head], inFlight: [], awaitingReview: [] }, stash: [behind] })
    const row = renderer(queued).renderNowSection(queued.now, queued.staleness).querySelector<HTMLElement>('[data-fiber-id="head"]')!
    expect(row.querySelector('.kbn-card-meta > .kbn-card-queued')?.textContent).toMatch(/1/)
    expect(row.querySelector(':scope > .kbn-card-queued-list')).not.toBeNull()
  })
})

describe('the preview is the full card, built for one row', () => {
  const review = card({
    id: 'work/run', uid: 'ULID-RUN', name: 'Null tests', status: 'closed', shuttleKind: 'oneshot',
    outcome: 'Ran the **comparison**.', due: '2026-10-21', mirroredOrigins: ['cluster'],
  })
  const data = response({ now: { drafts: [], inFlight: [], awaitingReview: [review] } })

  it('reads the outcome, path, agent, due and where else the fiber lives', () => {
    const surfaces = renderer(data)
    const root = surfaces.renderNowSection(data.now, data.staleness)
    const preview = surfaces.buildCardPreview(root.querySelector<HTMLElement>('[data-card-uid="ULID-RUN"]')!)!
    expect(preview.el.querySelector('.kbn-card-name')?.textContent).toBe('Null tests')
    expect(preview.el.querySelector('.kbn-card-id')?.textContent).toBe('work/run')
    expect(preview.el.querySelector('.kbn-card-outcome strong')?.textContent).toBe('comparison')
    // The full card names the agent even when it is the fleet default.
    expect(preview.el.querySelector('.kbn-card-actor')?.textContent).toBe('claude-opus')
    expect(preview.el.querySelector('.kbn-card-due')).not.toBeNull()
    expect(preview.el.textContent).toContain('also on cluster')
    expect(preview.el.dataset.column).toBe('awaitingReview')
    expect(preview.el.classList.contains('kbn-card')).toBe(false)
    expect(preview.el.querySelector('.kbn-preview-report')).toBeNull()
  })

  it('leads with a live thumbnail of the newest report, released on dispose', () => {
    const surfaces = renderer(data, { 'work/run': REPORT })
    const root = surfaces.renderNowSection(data.now, data.staleness)
    const preview = surfaces.buildCardPreview(root.querySelector<HTMLElement>('[data-card-uid="ULID-RUN"]')!)!
    const figure = preview.el.firstElementChild as HTMLElement
    expect(figure.classList.contains('kbn-preview-report')).toBe(true)
    const thumb = figure.querySelector<HTMLElement>('.ws-thumbnail')!
    expect(thumb).not.toBeNull()
    expect(figure.querySelector('figcaption')?.textContent).toBe('report.html3h ago')
    document.body.append(preview.el)
    preview.dispose()
    expect(thumb.isConnected).toBe(false)
  })

  it('answers null for a row whose card has left the response', () => {
    const stray = document.createElement('div')
    stray.dataset.cardUid = 'gone'
    stray.dataset.cardOrigin = 'local'
    expect(renderer(data).buildCardPreview(stray)).toBeNull()
  })
})
