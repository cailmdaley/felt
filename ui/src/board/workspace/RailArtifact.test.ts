// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ARTIFACT_ASPECT, ARTIFACT_MIN_HEIGHT, ARTIFACT_RESERVE, ARTIFACT_VIRTUAL_MIN, RailArtifact, railArtifactGeometry } from './RailArtifact.js'
import { buildChannel, channelLead } from './documents.js'

const viewers: HTMLElement[] = []
const disposed: HTMLElement[] = []
const navigators = new Map<HTMLElement, (href: string) => void>()
const navigateOf = (el: HTMLElement) => navigators.get(el)!
vi.mock('../FileViewerPanel.js', () => ({
  buildFileViewer: (_base: string, path: string, owner: string, _load: unknown, _text: unknown, options: { onNavigate?: (href: string) => void }) => {
    const el = document.createElement('div'); el.dataset.path = path; el.dataset.owner = owner; viewers.push(el)
    navigators.set(el, options.onNavigate ?? (() => {})); return el
  },
  disposeFileViewer: (el: HTMLElement | null) => { if (el) disposed.push(el) },
}))

describe('railArtifactGeometry', () => {
  it('lays a narrow rail out at the virtual minimum and scales it down', () => {
    const g = railArtifactGeometry(360, 2000, ARTIFACT_RESERVE)
    expect(g.virtualWidth).toBe(ARTIFACT_VIRTUAL_MIN)
    expect(g.scale).toBeCloseTo(360 / ARTIFACT_VIRTUAL_MIN)
  })
  it('reaches 1:1 once the rail is as wide as the virtual minimum, and stays there wider', () => {
    expect(railArtifactGeometry(ARTIFACT_VIRTUAL_MIN, 2000, 0).scale).toBe(1)
    const wide = railArtifactGeometry(900, 2000, 0)
    expect(wide).toMatchObject({ virtualWidth: 900, scale: 1 })
  })
  it('grows the scale monotonically as the rail widens', () => {
    const scales = [240, 320, 480, 640, 720, 960].map(w => railArtifactGeometry(w, 2000, ARTIFACT_RESERVE).scale)
    for (let i = 1; i < scales.length; i++) expect(scales[i]).toBeGreaterThanOrEqual(scales[i - 1])
  })
  it('follows the width as a page would while the rail has room', () => {
    expect(railArtifactGeometry(300, 2000, ARTIFACT_RESERVE).height).toBe(Math.round(300 * ARTIFACT_ASPECT))
  })
  it('caps the height so the reserve stays beneath it', () => {
    const g = railArtifactGeometry(700, 800, 2 * ARTIFACT_RESERVE)
    expect(g.height).toBe(800 - 2 * ARTIFACT_RESERVE)
  })
  it('keeps a useful minimum, unless the rail itself is shorter', () => {
    expect(railArtifactGeometry(300, 300, 2 * ARTIFACT_RESERVE).height).toBe(ARTIFACT_MIN_HEIGHT)
    expect(railArtifactGeometry(300, 120, ARTIFACT_RESERVE).height).toBe(120)
  })
  it('takes the rest of the rail when nothing else stands in it', () => {
    expect(railArtifactGeometry(300, 1000, 0).height).toBe(1000)
  })
})

describe('RailArtifact', () => {
  let values: Map<string, string>
  beforeEach(() => {
    viewers.length = 0; disposed.length = 0
    values = new Map()
    vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) })
  })
  afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren() })
  const doc = (path: string) => channelLead(buildChannel({ uid: 'task', owner: 'host-b', name: 'Task', path: '/notes/task.md', fiberDir: '/notes', body: '', sent: [{ path, time: 1 }] }))!

  it('is absent without an artifact and loads only while live', () => {
    const section = new RailArtifact('')
    section.show(null, vi.fn())
    expect(section.el.hidden).toBe(true); expect(section.present).toBe(false)
    section.show(doc('/notes/artifact.html'), vi.fn())
    expect(section.el.hidden).toBe(false); expect(viewers).toHaveLength(0)
    section.setLive(true)
    expect(viewers).toHaveLength(1)
    expect(viewers[0].dataset).toMatchObject({ path: '/notes/artifact.html', owner: 'host-b' })
    section.setLive(true); section.show(doc('/notes/artifact.html'), vi.fn())
    expect(viewers).toHaveLength(1)
    section.setLive(false)
    expect(disposed).toEqual([viewers[0]]); expect(section.el.querySelector('[data-path]')).toBeNull()
  })
  it('replaces the page when the artifact changes', () => {
    const section = new RailArtifact('')
    section.show(doc('/notes/artifact.html'), vi.fn()); section.setLive(true)
    section.show(doc('/notes/report.html'), vi.fn())
    expect(disposed).toEqual([viewers[0]])
    expect(viewers.map(v => v.dataset.path)).toEqual(['/notes/artifact.html', '/notes/report.html'])
  })
  it('folds and remembers it, unloading the page while folded', () => {
    const section = new RailArtifact('')
    section.show(doc('/notes/artifact.html'), vi.fn()); section.setLive(true)
    const toggle = section.el.querySelector<HTMLButtonElement>('.ws-rail-artifact-toggle')!
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    toggle.click()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(section.el.querySelector<HTMLElement>('.ws-rail-artifact-body')!.hidden).toBe(true)
    expect(disposed).toEqual([viewers[0]])
    expect(values.get('shuttle:workspace:rail-artifact-open')).toBe('false')
    const again = new RailArtifact('')
    again.show(doc('/notes/artifact.html'), vi.fn()); again.setLive(true)
    expect(again.isExpanded).toBe(false); expect(viewers).toHaveLength(1)
    again.el.querySelector<HTMLButtonElement>('.ws-rail-artifact-toggle')!.click()
    expect(viewers).toHaveLength(2)
  })
  it('keeps only its heading while the artifact fills the stage, and draws the page again after', () => {
    const section = new RailArtifact(''), d = doc('/notes/artifact.html')
    section.show(d, vi.fn()); section.setLive(true)
    section.show(d, vi.fn(), true)
    expect(section.el.hidden).toBe(false); expect(section.present).toBe(true)
    expect(section.el.querySelector<HTMLElement>('.ws-rail-artifact-body')!.hidden).toBe(true)
    expect(disposed).toEqual([viewers[0]])
    expect(section.el.querySelector<HTMLButtonElement>('.ws-rail-artifact-toggle')!.disabled).toBe(true)
    section.show(d, vi.fn(), false)
    expect(viewers).toHaveLength(2)
  })
  it('follows its links through the reader and refits when unfolded', () => {
    const navigate = vi.fn(), section = new RailArtifact('', navigate), refit = vi.fn(), d = doc('/notes/artifact.html')
    section.onUnfold = refit
    section.show(d, vi.fn()); section.setLive(true)
    const toggle = section.el.querySelector<HTMLButtonElement>('.ws-rail-artifact-toggle')!
    toggle.click(); refit.mockClear(); toggle.click()
    expect(refit).toHaveBeenCalled()
    navigateOf(viewers.at(-1)!)('plots/fig.png')
    expect(navigate).toHaveBeenCalledWith(d, 'plots/fig.png')
  })
  it('opens the full page from its own control', () => {
    const section = new RailArtifact(''), open = vi.fn(), d = doc('/notes/artifact.html')
    section.show(d, open)
    section.el.querySelector<HTMLButtonElement>('.ws-rail-artifact-full')!.click()
    expect(open).toHaveBeenCalledWith(d.key)
  })
})
