import { buildFileViewer, disposeFileViewer } from '../FileViewerPanel.js'
import { LOAD_POLICY } from '../views/shelfLoad.js'
import { docKey, documentKind } from './documents.js'
import { cacheDocumentTitle, declaredTitle, watchDocumentTitles } from './DocumentTitles.js'
import './thumbnail.css'

export interface ThumbnailFile { fullPath: string; owner: string; basename: string }
export interface ThumbnailOptions {
  key: string
  shuttleBase: string
  file?: ThumbnailFile
  fallback: string
  className?: string
  /** A caption beside the thumbnail already names the document, so the face and glyph card leave the name out. */
  captioned?: boolean
  /** Visible candidates outrank the loading ring; zero suspends loading. */
  priority(): number
  distance(): number
  onAspect?(aspect: number): void
}

/** One shared budget for the overview and every strip, with stable nearest-first loading. */
class ThumbnailBudget {
  readonly thumbnails = new Set<Thumbnail>()
  private raf?: number
  schedule(): void {
    if (this.raf !== undefined) return
    this.raf = requestAnimationFrame(() => { this.raf = undefined; this.pump() })
  }
  flush(): void {
    if (this.raf !== undefined) cancelAnimationFrame(this.raf)
    this.raf = undefined
    this.pump()
  }
  remove(thumb: Thumbnail): void {
    this.thumbnails.delete(thumb)
    if (!this.thumbnails.size) {
      if (this.raf !== undefined) cancelAnimationFrame(this.raf)
      this.raf = undefined
    } else this.schedule()
  }
  private pump(): void {
    const all = [...this.thumbnails]
    for (const thumb of all) thumb.scale()
    const candidates = all.filter(t => t.state === 'idle' && t.file && t.priority() > 0)
      .sort((a, b) => b.priority() - a.priority() || a.distance() - b.distance() || a.key.localeCompare(b.key))
    for (const candidate of candidates) {
      const population = all.filter(t => t.state === 'live' || t.state === 'loading')
      if (population.filter(t => t.state === 'loading').length >= LOAD_POLICY.maxConcurrent) break
      if (population.length >= LOAD_POLICY.maxLive) {
        const victim = population.filter(t => t.state === 'live' && t.priority() < candidate.priority())
          .sort((a, b) => a.priority() - b.priority() || a.lastVisible - b.lastVisible || b.distance() - a.distance())[0]
        if (!victim) break
        victim.unmount()
      }
      candidate.mount()
    }
  }
}
const budget = new ThumbnailBudget()
export function pumpThumbnails(): void { budget.flush() }

/** Sandboxed, inert, one-read previews; moving metadata never reloads the body. */
export class Thumbnail {
  readonly key: string
  readonly el: HTMLElement
  file?: ThumbnailFile
  state: 'idle' | 'loading' | 'live' | 'failed' = 'idle'
  near = false
  lastVisible = 0
  body?: HTMLElement
  private timer?: ReturnType<typeof setTimeout>
  private generation = 0
  private readonly opts: ThumbnailOptions
  private readonly face: HTMLElement
  private readonly title: HTMLElement
  private readonly preview: HTMLElement
  private readonly stopTitles: () => void

  constructor(opts: ThumbnailOptions) {
    this.opts = opts; this.key = opts.key; this.file = opts.file
    this.el = document.createElement('div')
    this.el.className = `ws-thumbnail ${opts.className ?? ''}`
    this.el.dataset.part = 'thumbnail'
    this.el.setAttribute('aria-hidden', 'true'); this.el.inert = true
    const kind = opts.file ? documentKind(opts.file.fullPath) : 'fiber'
    this.face = document.createElement('div'); this.face.className = 'ws-thumbnail-face ws-overview-thumb-face'
    this.face.dataset.part = 'thumbnail-face'
    const glyph = document.createElement('span'); glyph.className = 'ws-thumbnail-kind'
    glyph.textContent = { fiber: '§', html: '▣', image: '▨', pdf: '▧', text: '≡', audio: '♪', video: '▹', other: '□' }[kind]
    this.title = document.createElement('strong'); this.title.className = 'ws-thumbnail-title'
    this.preview = document.createElement('span'); this.preview.className = 'ws-thumbnail-preview'
    this.face.append(this.title, this.preview, glyph)
    this.el.append(this.face)
    this.paintFace()
    this.stopTitles = watchDocumentTitles(key => { if (key === this.documentKey) this.paintFace() })
    budget.thumbnails.add(this)
  }
  private get documentKey(): string | undefined { return this.file ? docKey(this.file.owner, this.file.fullPath, this.file.owner) : undefined }
  setProse(prose: string, title: string): void { this.title.textContent = title; this.preview.textContent = prose.slice(0, 800) }
  private paintFace(): void {
    const metadata = this.documentKey ? declaredTitle(this.documentKey) : undefined
    this.title.textContent = this.opts.captioned ? '' : metadata?.title ?? this.file?.basename ?? ''
    this.preview.textContent = metadata?.preview || (this.file ? '' : this.opts.fallback)
    const name = this.body?.querySelector<HTMLElement>('.kbn-thumbnail-name')
    if (name && !this.opts.captioned) {
      name.textContent = metadata?.title ?? this.file?.basename ?? ''
      name.classList.toggle('ws-thumbnail-declared-title', !!metadata?.title)
    }
  }
  priority(): number { return this.opts.priority() }
  distance(): number { return this.opts.distance() }
  schedule(): void { budget.schedule() }
  dispose(): void { this.stopTitles(); budget.remove(this); this.unmount(); this.el.remove() }
  unmount(): void {
    this.generation++
    clearTimeout(this.timer); this.timer = undefined
    disposeFileViewer(this.body ?? null)
    this.body?.remove(); this.body = undefined; this.state = 'idle'
    this.el.classList.remove('ws-thumbnail-ready')
  }
  scale(): void {
    if (!this.body) return
    const content = this.body.querySelector<HTMLElement>('iframe,pre')
    if (!content) return
    const width = this.body.classList.contains('kbn-thumbnail-pdf') ? 900 : content.tagName === 'IFRAME' ? 1040 : 760
    const scale = (this.el.clientWidth || 176) / width
    content.style.width = `${width}px`; content.style.transform = `scale(${scale})`
    if (content.tagName === 'IFRAME') content.style.height = `${Math.ceil((this.el.clientHeight || 116) / scale)}px`
  }
  mount(): void {
    const file = this.file
    if (!file || this.state !== 'idle') return
    const generation = ++this.generation
    this.state = 'loading'
    const finish = (ok: boolean): void => {
      if (this.generation !== generation || this.state !== 'loading') return
      clearTimeout(this.timer); this.timer = undefined
      this.state = ok ? 'live' : 'failed'
      this.el.classList.toggle('ws-thumbnail-ready', ok)
      if (!ok) { disposeFileViewer(this.body ?? null); this.body?.remove(); this.body = undefined }
      this.scale(); budget.schedule()
    }
    this.timer = setTimeout(() => finish(false), LOAD_POLICY.softTimeoutRemoteMs)
    const kind = documentKind(file.fullPath)
    this.body = buildFileViewer(this.opts.shuttleBase, file.fullPath, file.owner, undefined, undefined, {
      kind: kind === 'fiber' ? undefined : kind, thumbnail: true, thumbnailLabel: !this.opts.captioned, active: false,
      onState: state => finish(state.status === 'ready'),
      onThumbnailSource: (source, etag) => {
        if (this.documentKey && this.generation === generation) cacheDocumentTitle(this.documentKey, file.fullPath, source, etag)
      },
    })
    this.body.classList.add('ws-thumbnail-body', 'ws-overview-thumb-body')
    this.el.append(this.body)
    this.paintFace()
    const img = this.body.querySelector('img')
    img?.addEventListener('load', () => {
      if (img.naturalWidth && img.naturalHeight) this.opts.onAspect?.(img.naturalWidth / img.naturalHeight)
    }, { once: true })
    this.scale()
  }
}
