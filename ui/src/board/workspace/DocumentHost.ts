import type { WorkspaceDocument, DocKey } from './documents.js'
import { keyIntent, shouldForwardDocumentKey, surfaceBindings } from '../keymap.js'
import {
  buildFileViewer, disposeFileViewer, loadFileViewerOnce, resumeFileViewer, suspendFileViewer,
  type FileViewerState,
} from '../FileViewerPanel.js'
import { refreshLiveFile } from '../LiveFileRefresh.js'
import { fileBytesUrl } from '../utils.js'
import { blockingDialogOpen } from '../views/ViewRegistry.js'

export interface DocumentFrame {
  el: HTMLElement
  sheet: HTMLElement
  content: HTMLElement
  label: HTMLElement
  doc: WorkspaceDocument
  viewer: HTMLElement | null
}

type ScrollPosition = { x: number; y: number }
type FrameState = {
  frame: DocumentFrame
  pending: HTMLElement | null
  loaded: boolean
  active: boolean
  initialSuspended: boolean
  scroll: ScrollPosition
  readScroll: (() => ScrollPosition) | null
  stopScroll: (() => void) | null
  notice: HTMLElement | null
  controller: AbortController | null
  revision: number
}

const RETAIN = 10
const SCROLL_PREFIX = 'shuttle:workspace:scroll:'

/** HTML documents forward workspace chords without changing their own navigation. */
export function withWorkspaceKeyBridge(html: string): string {
  // Install after report load handlers so its document/window dialogs get first refusal.
  const bridge = `<script data-shuttle-workspace-bridge>(function(intent,forward,bindings){window.addEventListener('load',function(){window.setTimeout(function(){window.addEventListener('keydown',function(e){if(!forward(e)||!intent(e,'reader',bindings,function(target){return !forward({target:target,defaultPrevented:false})}))return;e.preventDefault();e.stopPropagation();parent.postMessage({type:'shuttle-workspace-key',key:e.key,altKey:e.altKey,ctrlKey:e.ctrlKey,metaKey:e.metaKey,shiftKey:e.shiftKey,repeat:e.repeat},'*')})},0)},{once:true})})(${keyIntent.toString()},${shouldForwardDocumentKey.toString()},${JSON.stringify(surfaceBindings)});</script>`
  const head = /<head\b[^>]*>/i
  return head.test(html) ? html.replace(head, (tag) => tag + bridge) : bridge + html
}

/** Stable frames, a fleet-wide live-document budget, and selected-only polling. */
export class DocumentHost {
  private readonly frames = new Map<DocKey, FrameState>()
  private readonly live = new Map<DocKey, FrameState>()
  private documents: WorkspaceDocument[] = []
  private selected: DocKey | null = null
  private disposed = false
  private readonly track: HTMLElement
  private readonly options: {
    shuttleBase: string
    buildProse: (doc: WorkspaceDocument) => HTMLElement
    onSelect: (key: DocKey) => void
    onFrame?: (frame: DocumentFrame) => void
    /** The controller owns fetching fiber bodies; it calls updateProse on success. */
    onRefreshProse?: (doc: WorkspaceDocument) => void | Promise<void>
  }

  constructor(track: HTMLElement, options: DocumentHost['options']) {
    this.track = track
    this.options = options
    window.addEventListener('message', this.onMessage)
    document.addEventListener('keydown', this.onMediaKey, true)
  }

  get(key: DocKey): DocumentFrame | undefined {
    return this.frames.get(key)?.frame
  }

  setChannel(documents: WorkspaceDocument[], selected: DocKey): void {
    if (this.disposed) return
    this.documents = documents
    for (const doc of documents) {
      const state = this.frames.get(doc.key) ?? this.create(doc)
      // Provenance and labels can change without touching the live document.
      state.frame.doc = doc
    }
    this.select(selected)
  }

  select(key: DocKey): void {
    if (this.disposed) return
    const index = this.documents.findIndex((doc) => doc.key === key)
    if (index < 0) {
      this.parkAll()
      return
    }
    this.selected = key
    const current = new Set(this.documents.map((doc) => doc.key))
    for (const [id, state] of this.frames) {
      const parked = !current.has(id)
      const selected = !parked && id === key
      state.frame.el.classList.toggle('ws-parked', parked)
      state.frame.el.classList.toggle('ws-receded', !parked && !selected)
      state.frame.el.classList.toggle('ws-selected', selected)
      state.frame.el.inert = parked
      state.frame.sheet.inert = !selected
      state.frame.el.setAttribute('aria-hidden', String(!selected))
      this.setActive(state, selected)
      // A neighbour's initial load is allowed only while its channel is visible.
      if (parked) {
        state.initialSuspended = !state.loaded && !!state.frame.viewer
        suspendFileViewer(state.frame.viewer)
        suspendFileViewer(state.pending)
      }
    }
    // Touch neighbours first, leaving the actual subject newest in the LRU.
    const visible = [index - 1, index + 1, index]
      .filter((i) => i >= 0 && i < this.documents.length)
      .map((i) => this.documents[i].key)
    for (const id of visible) {
      const state = this.frames.get(id)!
      this.mount(state)
      this.live.delete(id)
      this.live.set(id, state)
    }
    while (this.live.size > RETAIN) {
      const victim = [...this.live.keys()].find((id) => !visible.includes(id))
      if (victim === undefined) break
      this.evict(this.live.get(victim)!)
      this.live.delete(victim)
    }
  }

  /** Replace only fiber prose when its body or channel metadata changes. */
  updateProse(key: DocKey, element: HTMLElement): void {
    const state = this.frames.get(key)
    if (this.disposed || !state || state.frame.doc.kind !== 'fiber' || !state.frame.viewer) return
    this.saveScroll(state)
    state.stopScroll?.()
    state.frame.content.replaceChildren(element)
    state.frame.viewer = element
    state.loaded = true
    this.clearNotice(state)
    this.bindScroller(state, element)
    this.live.delete(key)
    this.live.set(key, state)
  }

  /** Live text uses its staged renderer; native media swaps only after load. */
  refresh(key: DocKey): void {
    const state = this.frames.get(key)
    if (this.disposed || !state) return
    if (!state.frame.viewer) {
      this.mount(state)
      return
    }
    if (state.frame.doc.kind === 'fiber') {
      if (this.options.onRefreshProse) void this.refreshProse(state)
      else this.updateProse(key, this.options.buildProse(state.frame.doc))
      return
    }
    if (state.frame.doc.kind === 'html' || state.frame.doc.kind === 'text') {
      void this.revalidate(state)
      return
    }
    this.saveScroll(state)
    this.buildViewer(state, true)
  }

  parkAll(): void {
    this.selected = null
    this.documents = []
    for (const state of this.frames.values()) {
      state.frame.el.classList.add('ws-parked')
      state.frame.el.classList.remove('ws-selected', 'ws-receded')
      state.frame.el.inert = true
      state.frame.sheet.inert = true
      state.frame.el.setAttribute('aria-hidden', 'true')
      this.setActive(state, false)
      state.initialSuspended = !state.loaded && !!state.frame.viewer
      suspendFileViewer(state.frame.viewer)
      suspendFileViewer(state.pending)
      this.saveScroll(state)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener('message', this.onMessage)
    document.removeEventListener('keydown', this.onMediaKey, true)
    for (const state of this.frames.values()) {
      this.evict(state)
      state.frame.el.remove()
    }
    this.live.clear()
    this.frames.clear()
  }

  private create(doc: WorkspaceDocument): FrameState {
    const el = document.createElement('div')
    el.className = 'ws-page'
    el.dataset.key = doc.key
    const sheet = document.createElement('div')
    sheet.className = 'ws-sheet'
    const content = document.createElement('div')
    content.className = 'ws-content'
    const label = document.createElement('div')
    label.className = 'ws-labelbar'
    sheet.append(content, label)
    el.append(sheet)
    const frame: DocumentFrame = { el, sheet, content, label, doc, viewer: null }
    const state: FrameState = {
      frame, pending: null, loaded: false, active: false, initialSuspended: false,
      scroll: readScroll(doc.key), readScroll: null, stopScroll: null,
      notice: null, controller: null, revision: 0,
    }
    this.placeholder(state)
    el.addEventListener('click', () => {
      if (el.classList.contains('ws-receded')) this.options.onSelect(frame.doc.key)
    })
    this.frames.set(doc.key, state)
    // This is the only append of a frame. Reordering is geometry, not DOM motion.
    this.track.append(el)
    this.options.onFrame?.(frame)
    return state
  }

  private mount(state: FrameState): void {
    if (state.frame.viewer) {
      if (state.initialSuspended) {
        state.initialSuspended = false
        loadFileViewerOnce(state.frame.viewer)
      }
      return
    }
    if (state.frame.doc.kind === 'fiber') {
      const prose = this.options.buildProse(state.frame.doc)
      state.frame.content.replaceChildren(prose)
      state.frame.viewer = prose
      state.loaded = true
      this.bindScroller(state, prose)
    } else {
      this.buildViewer(state, false)
    }
  }

  private buildViewer(state: FrameState, replacement: boolean): void {
    state.revision++
    const revision = state.revision
    if (state.pending) {
      disposeFileViewer(state.pending)
      state.pending.remove()
      state.pending = null
    }
    const doc = state.frame.doc
    let bindReplacementScroll: (() => void) | null = null
    const viewer = buildFileViewer(
      this.options.shuttleBase, doc.path, doc.owner,
      (iframe, refreshed) => {
        if (state.revision !== revision || this.disposed) return
        if (replacement && state.pending) bindReplacementScroll = () => this.bindFrameScroll(state, iframe, false)
        else this.bindFrameScroll(state, iframe, refreshed)
      },
      (scroller) => {
        if (state.revision !== revision || this.disposed) return
        if (replacement && state.pending) bindReplacementScroll = () => this.bindScroller(state, scroller)
        else this.bindScroller(state, scroller)
      },
      {
        quietLoading: true,
        active: state.active,
        kind: doc.kind === 'fiber' ? undefined : doc.kind,
        title: documentTitle(doc),
        provenance: documentProvenance(doc),
        transformHtml: withWorkspaceKeyBridge,
        // A shared watcher may deliver cached text synchronously during build.
        onState: (result) => queueMicrotask(() => {
          if (this.disposed || state.revision !== revision) return
          if (replacement && result.status === 'ready') this.saveScroll(state)
          this.viewerState(state, viewer, result)
          if (replacement && result.status === 'ready') bindReplacementScroll?.()
        }),
      },
    )
    viewer.classList.add('ws-document-viewer')
    viewer.style.opacity = '0'
    if (replacement) {
      viewer.style.position = 'absolute'
      viewer.style.inset = '0'
      state.pending = viewer
      state.frame.content.append(viewer)
    } else {
      state.frame.content.replaceChildren(viewer)
      state.frame.viewer = viewer
    }
  }

  private viewerState(state: FrameState, viewer: HTMLElement, result: FileViewerState): void {
    if (result.status === 'error') {
      if (state.pending === viewer) {
        disposeFileViewer(viewer)
        viewer.remove()
        state.pending = null
      }
      this.failure(state, result.error, state.loaded || result.hasContent)
      if (!state.active) suspendFileViewer(viewer)
      return
    }
    if (state.pending === viewer) {
      const old = state.frame.viewer
      disposeFileViewer(old)
      old?.remove()
      state.frame.viewer = viewer
      state.pending = null
      viewer.style.position = ''
      viewer.style.inset = ''
    }
    viewer.style.opacity = ''
    state.loaded = true
    state.initialSuspended = false
    this.clearNotice(state)
    if (!state.active) suspendFileViewer(viewer)
  }

  private setActive(state: FrameState, active: boolean): void {
    if (state.active === active) return
    if (!active) this.saveScroll(state)
    state.active = active
    if (active) {
      state.initialSuspended = false
      resumeFileViewer(state.frame.viewer)
      resumeFileViewer(state.pending)
    }
    else {
      state.initialSuspended = !state.loaded && !!state.frame.viewer
      suspendFileViewer(state.frame.viewer)
    }
    if (!active) suspendFileViewer(state.pending)
  }

  private evict(state: FrameState): void {
    this.saveScroll(state)
    state.revision++
    state.controller?.abort()
    state.controller = null
    state.stopScroll?.()
    state.stopScroll = null
    state.readScroll = null
    disposeFileViewer(state.frame.viewer)
    disposeFileViewer(state.pending)
    state.pending = null
    state.frame.viewer = null
    state.loaded = false
    state.initialSuspended = false
    state.notice = null
    this.placeholder(state)
  }

  private placeholder(state: FrameState): void {
    const placeholder = document.createElement('div')
    placeholder.className = 'ws-placeholder'
    placeholder.setAttribute('aria-label', state.frame.doc.name)
    state.frame.content.replaceChildren(placeholder)
  }

  private failure(state: FrameState, error: unknown, stale: boolean): void {
    this.clearNotice(state)
    const message = error instanceof Error ? error.message : ''
    const missing = /file request failed: (404|410)\b/.test(message)
    const notice = document.createElement('div')
    notice.className = stale ? 'ws-document-status' : 'ws-document-state'
    notice.setAttribute('role', 'status')
    const cause = document.createElement('p')
    const owner = state.frame.doc.owner
    const unsupportedMedia = message === 'media format is not supported by this browser'
    cause.textContent = missing
      ? `Not found on ${owner}${stale ? ' — showing last loaded copy' : ''}`
      : unsupportedMedia ? 'This browser cannot play this format'
      : `${owner} is unreachable${stale ? ' — showing last loaded copy' : ''}`
    notice.append(cause)
    if (unsupportedMedia) {
      const download = document.createElement('a')
      download.href = fileBytesUrl(this.options.shuttleBase, state.frame.doc.path, owner)
      download.download = state.frame.doc.name
      download.textContent = 'Download'
      notice.append(download)
    }
    if (missing) {
      const path = document.createElement('code')
      path.className = 'ws-document-path'
      path.textContent = state.frame.doc.path
      path.tabIndex = 0
      notice.append(path)
    }
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.textContent = 'Retry'
    retry.addEventListener('click', () => this.refresh(state.frame.doc.key))
    notice.append(retry)
    state.frame.content.append(notice)
    state.notice = notice
    state.frame.el.classList.toggle('ws-stale', stale)
  }

  private clearNotice(state: FrameState): void {
    state.notice?.remove()
    state.notice = null
    state.frame.el.classList.remove('ws-stale')
  }

  private async refreshProse(state: FrameState): Promise<void> {
    try {
      await this.options.onRefreshProse?.(state.frame.doc)
    } catch (error) {
      if (!this.disposed) this.failure(state, error, state.loaded)
    }
  }

  private async revalidate(state: FrameState): Promise<void> {
    state.controller?.abort()
    const controller = new AbortController()
    state.controller = controller
    const doc = state.frame.doc
    const src = fileBytesUrl(this.options.shuttleBase, doc.path, doc.owner)
    try {
      const response = await fetch(src, { method: 'HEAD', signal: controller.signal, cache: 'no-store' })
      if (this.disposed || state.controller !== controller) return
      if (!response.ok) throw new Error(`file request failed: ${response.status}`)
      this.clearNotice(state)
      await refreshLiveFile(src)
    } catch (error) {
      if (!this.disposed && !controller.signal.aborted) this.failure(state, error, state.loaded)
    }
  }

  private bindScroller(state: FrameState, scroller: HTMLElement): void {
    state.stopScroll?.()
    scroller.scrollTop = state.scroll.y
    scroller.scrollLeft = state.scroll.x
    // A fresh prose frame receives its reading geometry later in the same turn.
    queueMicrotask(() => {
      if (this.disposed || !state.frame.viewer?.contains(scroller)) return
      scroller.scrollTop = state.scroll.y
      scroller.scrollLeft = state.scroll.x
    })
    const save = () => this.saveScroll(state)
    state.readScroll = () => ({ x: scroller.scrollLeft, y: scroller.scrollTop })
    scroller.addEventListener('scroll', save, { passive: true })
    state.stopScroll = () => scroller.removeEventListener('scroll', save)
  }

  private bindFrameScroll(state: FrameState, iframe: HTMLIFrameElement, refreshed: boolean): void {
    state.stopScroll?.()
    const win = iframe.contentWindow
    if (!win) return
    try {
      if (!refreshed) win.scrollTo(state.scroll.x, state.scroll.y)
      state.readScroll = () => ({ x: win.scrollX, y: win.scrollY })
      const save = () => this.saveScroll(state)
      win.addEventListener('scroll', save, { passive: true })
      state.stopScroll = () => win.removeEventListener('scroll', save)
    } catch {
      // Browser-native PDF frames cannot expose their internal scroll offset.
      this.bindScroller(state, state.frame.content)
    }
  }

  private saveScroll(state: FrameState): void {
    try {
      state.scroll = state.readScroll?.() ?? state.scroll
      sessionStorage.setItem(SCROLL_PREFIX + state.frame.doc.key, JSON.stringify(state.scroll))
    } catch {
      // Storage denial and cross-origin frames do not interrupt reading.
    }
  }

  /** Space belongs to a selected media page, without changing the app keymap. */
  private readonly onMediaKey = (event: KeyboardEvent): void => {
    if (!this.selected || event.key !== ' ' || event.altKey || event.ctrlKey || event.metaKey || event.repeat) return
    const state = this.frames.get(this.selected)
    if (!state?.active || state.frame.el.closest('[inert]') || blockingDialogOpen() || this.track.closest('.ws-reader')?.querySelector('.ws-menu')) return
    const intent = keyIntent(event, 'reader')
    if (intent !== 'pageDown' && intent !== 'pageUp') return
    const media = state.frame.viewer?.querySelector('audio,video') as HTMLMediaElement | null
    if (!media) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (media.paused) void media.play().catch(() => { /* Native controls remain available after a refused autoplay. */ })
    else media.pause()
  }

  private readonly onMessage = (event: MessageEvent): void => {
    if (this.disposed || !this.selected) return
    const state = this.frames.get(this.selected)
    const frames = state?.frame.viewer?.querySelectorAll('iframe')
    if (!event.source || !frames || ![...frames].some((frame) => frame.contentWindow === event.source)) return
    const data = event.data as Record<string, unknown> | null
    if (!data || data.type !== 'shuttle-workspace-key') return
    if (typeof data.key !== 'string' || state?.frame.doc.kind !== 'html') return
    const forwarded = new KeyboardEvent('keydown', {
      key: data.key, altKey: data.altKey === true, ctrlKey: data.ctrlKey === true,
      metaKey: data.metaKey === true, shiftKey: data.shiftKey === true, repeat: data.repeat === true,
      bubbles: true, cancelable: true,
    })
    if (!keyIntent(forwarded, 'reader')) return
    // Bubble through the same app handler; keys never focus a document.
    this.track.dispatchEvent(forwarded)
  }
}

function documentTitle(doc: WorkspaceDocument): string {
  const embed = doc.provenance.find(p => p.kind === 'embed' && p.title)
  return embed?.kind === 'embed' ? embed.title || doc.name : doc.name
}

function documentProvenance(doc: WorkspaceDocument): string {
  const receipts = doc.provenance.filter(p => p.kind === 'sent')
  const latest = receipts.at(-1)
  const source = latest?.kind === 'sent'
    ? `sent · ${receipts.length} ${receipts.length === 1 ? 'receipt' : 'receipts'}${latest.worker ? ` · ${latest.worker}` : ''}`
    : doc.provenance.some(p => p.kind === 'embed') ? 'embedded' : 'linked from body'
  return `${source} · ${doc.owner}`
}

function readScroll(key: DocKey): ScrollPosition {
  try {
    const value = JSON.parse(sessionStorage.getItem(SCROLL_PREFIX + key) ?? 'null') as Partial<ScrollPosition> | null
    if (value && typeof value.x === 'number' && typeof value.y === 'number' && Number.isFinite(value.x) && Number.isFinite(value.y)) {
      return { x: Math.max(0, value.x), y: Math.max(0, value.y) }
    }
  } catch { /* Storage is optional. */ }
  return { x: 0, y: 0 }
}
