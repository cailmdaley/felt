import type { WorkspaceDocument, DocKey } from './documents.js'
import { DOCUMENT_KEY_INTENTS, keyIntent } from '../keymap.js'
import { frameBridge, type DocumentKey } from './DocumentBridge.js'
export { withWorkspaceKeyBridge } from './DocumentBridge.js'
import {
  buildFileViewer, disposeFileViewer, loadFileViewerOnce, playFileViewerAudio, resumeFileViewer, suspendFileViewer,
  type FileViewerState,
} from '../FileViewerPanel.js'
import { refreshLiveFile } from '../LiveFileRefresh.js'
import { fileBytesUrl } from '../utils.js'
import { cacheDocumentTitle, watchDocumentTitles } from './DocumentTitles.js'
import { blockingDialogOpen } from '../views/ViewRegistry.js'
import { AudioPage, keepAudioPosition, seekAudio, toggleAudio } from './AudioPage.js'
import { referenceRuntime, referenceTargets, resolveChannelReference, type ReferenceSurface } from './ChannelReferences.js'

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
  transferTime: number | null
  weight: number
  references: ReferenceSurface | null
  referenceCandidates: string[]
}

const RETAIN = 10
const SCROLL_PREFIX = 'shuttle:workspace:scroll:'

/** Stable frames, a fleet-wide live-document budget, and selected-only polling. */
export class DocumentHost {
  private readonly frames = new Map<DocKey, FrameState>()
  private readonly live = new Map<DocKey, FrameState>()
  private readonly audioPages = new Map<HTMLAudioElement, AudioPage>()
  private documents: WorkspaceDocument[] = []
  private selected: DocKey | null = null
  private inlineAudio: { source: DocKey; target: DocKey } | null = null
  private disposed = false
  private readonly stopTitles: () => void
  private readonly track: HTMLElement
  private readonly options: {
    shuttleBase: string
    buildProse: (doc: WorkspaceDocument) => HTMLElement
    onSelect: (key: DocKey) => void
    /** Active-document positions, including restoration, from local or validated bridge scrolls. */
    onScroll?: (key: DocKey, y: number) => void
    onFrame?: (frame: DocumentFrame) => void
    /** The controller owns fetching fiber bodies; it calls updateProse on success. */
    onRefreshProse?: (doc: WorkspaceDocument) => void | Promise<void>
  }

  constructor(track: HTMLElement, options: DocumentHost['options']) {
    this.track = track
    this.options = options
    this.stopTitles = watchDocumentTitles(() => this.refreshReferences())
    document.addEventListener('keydown', this.onMediaKey, true)
  }

  get(key: DocKey): DocumentFrame | undefined {
    return this.frames.get(key)?.frame
  }

  setChannel(documents: WorkspaceDocument[], selected: DocKey): void {
    if (this.disposed) return
    this.documents = documents
    if (this.inlineAudio && !documents.some(doc => doc.key === this.inlineAudio?.target)) this.stopInlineAudio()
    for (const doc of documents) {
      const state = this.frames.get(doc.key) ?? this.create(doc)
      // Provenance and labels can change without touching the live document.
      state.frame.doc = doc
    }
    this.select(selected)
    this.refreshReferences()
    for (const page of this.audioPages.values()) page.updateDocuments(documents)
    this.pruneFrames()
  }

  select(key: DocKey): void {
    if (this.disposed) return
    const index = this.documents.findIndex((doc) => doc.key === key)
    if (index < 0) {
      this.parkAll()
      return
    }
    if (key !== this.selected) this.stopInlineAudio()
    const previous = this.selected ? this.frames.get(this.selected) : undefined
    const oldAudio = previous?.frame.viewer?.querySelector('audio')
    const target = this.frames.get(key)!
    if (key !== this.selected && target.frame.doc.kind === 'audio' && oldAudio && keepAudioPosition() && this.documents.some(d => d.key === this.selected)) {
      target.transferTime = oldAudio.currentTime
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
      this.transferAudioPosition(state)
    }
    this.enforceBudget(visible)
  }

  private enforceBudget(visible = this.visibleKeys()): void {
    while ([...this.live.values()].reduce((sum, state) => sum + state.weight, 0) > RETAIN) {
      const victim = [...this.live.keys()].find(id => !visible.includes(id))
      if (victim === undefined) break
      this.evict(this.live.get(victim)!)
      this.live.delete(victim)
    }
    this.pruneFrames()
  }
  private visibleKeys(): DocKey[] {
    const index = this.documents.findIndex(doc => doc.key === this.selected)
    return index < 0 ? [] : [...this.documents.slice(Math.max(0, index - 1), index + 2).map(doc => doc.key), ...(this.inlineAudio ? [this.inlineAudio.target] : [])]
  }
  /** Current-channel placeholders give the filmstrip its geometry, not retained state. */
  private pruneFrames(): void {
    const current = new Set(this.documents.map(doc => doc.key))
    for (const [key, state] of this.frames) {
      if (current.has(key) || this.live.has(key)) continue
      state.frame.el.remove()
      this.frames.delete(key)
    }
  }

  /** Replace only fiber prose when its body or channel metadata changes. */
  updateProse(key: DocKey, element: HTMLElement): void {
    const state = this.frames.get(key)
    if (this.disposed || !state || state.frame.doc.kind !== 'fiber' || !state.frame.viewer) return
    this.saveScroll(state)
    state.stopScroll?.()
    state.references?.dispose()
    state.frame.content.replaceChildren(element)
    state.frame.viewer = element
    this.bindReferences(state, element)
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
    this.stopInlineAudio()
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
    this.stopTitles()
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
    sheet.dataset.part = 'page-frame'
    const content = document.createElement('div')
    content.className = 'ws-content'
    const label = document.createElement('div')
    label.className = 'ws-labelbar'
    label.dataset.part = 'label-bar'
    sheet.append(content, label)
    el.append(sheet)
    const frame: DocumentFrame = { el, sheet, content, label, doc, viewer: null }
    const state: FrameState = {
      frame, pending: null, loaded: false, active: false, initialSuspended: false,
      scroll: readScroll(doc.key), readScroll: null, stopScroll: null,
      notice: null, controller: null, revision: 0, transferTime: null, weight: 1, references: null, referenceCandidates: [],
    }
    this.placeholder(state)
    el.addEventListener('click', event => {
      // A selected page can recede in a descendant's handler before this bubbles.
      // Inert neighbour sheets target their surrounding frame, not their content.
      if (el.classList.contains('ws-receded') && !sheet.contains(event.target as Node)) this.options.onSelect(frame.doc.key)
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
      this.bindReferences(state, prose)
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
        decorateAudio: audio => {
          const page = new AudioPage(audio, doc, this.options.shuttleBase, this.options.onSelect)
          this.audioPages.set(audio, page)
          page.updateDocuments(this.documents)
          const changed = (): void => this.updateReferencePlayback()
          const events = ['play', 'pause', 'ended', 'timeupdate', 'durationchange', 'loadedmetadata']
          for (const event of events) audio.addEventListener(event, changed)
          return () => {
            for (const event of events) audio.removeEventListener(event, changed)
            page.dispose(); this.audioPages.delete(audio)
          }
        },
        decorateText: pane => this.bindReferences(state, pane),
        resolveReferences: candidates => {
          state.referenceCandidates = candidates
          queueMicrotask(() => this.updateReferencePlayback())
          return referenceTargets(candidates, state.frame.doc, this.documents)
        },
        onReferenceIntent: (type, candidate) => this.referenceIntent(state, type, candidate),
        onThumbnailSource: (source, etag) => cacheDocumentTitle(doc.key, doc.path, source, etag),
        onDocumentKey: key => this.forwardKey(state, key),
        onWeight: weight => queueMicrotask(() => {
          if (this.disposed || state.revision !== revision) return
          state.weight = weight
          this.enforceBudget()
        }),
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
    this.transferAudioPosition(state)
    if (!state.active && this.inlineAudio?.target !== state.frame.doc.key) suspendFileViewer(viewer)
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
    state.references?.dispose()
    state.references = null
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
    const save = (): void => {
      this.saveScroll(state)
      if (state.active) this.options.onScroll?.(state.frame.doc.key, state.scroll.y)
    }
    state.readScroll = () => ({ x: scroller.scrollLeft, y: scroller.scrollTop })
    scroller.addEventListener('scroll', save, { passive: true })
    state.stopScroll = () => scroller.removeEventListener('scroll', save)
  }

  private bindFrameScroll(state: FrameState, iframe: HTMLIFrameElement, refreshed: boolean): void {
    state.stopScroll?.()
    const bridge = frameBridge(iframe)
    if (!bridge) {
      // Browser-native PDF frames keep their internal scroll state themselves.
      this.bindScroller(state, state.frame.content)
      return
    }
    if (!refreshed) bridge.command('restore', state.scroll)
    state.readScroll = () => bridge.position
    state.stopScroll = bridge.subscribeScroll(position => {
      state.scroll = position
      this.saveScroll(state)
      if (state.active) this.options.onScroll?.(state.frame.doc.key, position.y)
    })
  }

  private refreshReferences(): void {
    if (this.disposed) return
    for (const doc of this.documents) {
      const state = this.frames.get(doc.key)
      state?.references?.scan()
      const frame = state?.frame.viewer?.querySelector('iframe')
      if (frame) frameBridge(frame)?.command('references:scan')
    }
  }

  private bindReferences(state: FrameState, root: HTMLElement): void {
    state.references?.dispose()
    const surface = referenceRuntime(root,
      candidates => {
        state.referenceCandidates = candidates
        surface.resolve(referenceTargets(candidates, state.frame.doc, this.documents))
        this.updateReferencePlayback()
      },
      (type, candidate) => this.referenceIntent(state, type, candidate), true)
    state.references = surface
    surface.scan()
  }

  private referenceIntent(state: FrameState, type: 'select' | 'play' | 'pause', candidate: string): void {
    if (this.disposed || !state.active || state.frame.doc.key !== this.selected) return
    const target = resolveChannelReference(candidate, state.frame.doc, this.documents)
    if (!target) return
    if (type === 'select') { this.options.onSelect(target.key); return }
    if (target.kind !== 'audio') return
    const audioState = this.frames.get(target.key)
    if (!audioState) return
    if (type === 'pause') {
      audioState.frame.viewer?.querySelector('audio')?.pause()
      this.updateReferencePlayback()
      return
    }
    this.stopInlineAudio()
    this.inlineAudio = { source: state.frame.doc.key, target: target.key }
    this.mount(audioState)
    this.live.delete(target.key); this.live.set(target.key, audioState)
    if (audioState.frame.viewer) playFileViewerAudio(audioState.frame.viewer)
    this.enforceBudget([...this.visibleKeys(), target.key])
  }

  private stopInlineAudio(): void {
    if (!this.inlineAudio) return
    const target = this.inlineAudio.target
    this.inlineAudio = null
    suspendFileViewer(this.frames.get(target)?.frame.viewer ?? null)
    this.updateReferencePlayback()
  }

  private updateReferencePlayback(): void {
    if (this.disposed || !this.selected) return
    const state = this.frames.get(this.selected)
    if (!state) return
    const states = state.referenceCandidates.flatMap(candidate => {
      const target = resolveChannelReference(candidate, state.frame.doc, this.documents)
      if (target?.kind !== 'audio') return []
      const audio = this.frames.get(target.key)?.frame.viewer?.querySelector('audio')
      return [{ candidate, playing: !!audio && !audio.paused,
        progress: audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.currentTime / audio.duration : 0 }]
    })
    for (const playback of states) state.references?.playback(playback)
    const frame = state.frame.viewer?.querySelector('iframe')
    if (frame) frameBridge(frame)?.command('references:playback', { states })
  }

  private saveScroll(state: FrameState): void {
    try {
      state.scroll = state.readScroll?.() ?? state.scroll
      sessionStorage.setItem(SCROLL_PREFIX + state.frame.doc.key, JSON.stringify(state.scroll))
    } catch {
      // Storage denial and cross-origin frames do not interrupt reading.
    }
  }

  private transferAudioPosition(state: FrameState): void {
    const audio = state.frame.viewer?.querySelector('audio')
    if (audio && audio.readyState >= 1 && state.transferTime !== null) {
      seekAudio(audio, state.transferTime)
      state.transferTime = null
    }
  }

  /** Audio keys do not take Space away from the reader. */
  private readonly onMediaKey = (event: KeyboardEvent): void => {
    if (!this.selected || !['p', ',', '>'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.keyCode === 229 || (event.key === 'p' && event.repeat)) return
    const state = this.frames.get(this.selected)
    if (!state?.active || state.frame.el.closest('[inert]') || blockingDialogOpen() || this.track.closest('.ws-reader')?.querySelector('.ws-menu')) return
    const intent = keyIntent(event, 'reader')
    if (!intent || !['audioPlay', 'audioBack', 'audioForward'].includes(intent)) return
    const media = state.frame.viewer?.querySelector('audio')
    if (!media) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (intent === 'audioPlay') toggleAudio(media)
    else seekAudio(media, media.currentTime + (intent === 'audioBack' ? -5 : 5))
  }

  private forwardKey(state: FrameState, data: DocumentKey): void {
    if (this.disposed || state.frame.doc.key !== this.selected || !state.active || state.frame.doc.kind !== 'html') return
    const forwarded = new KeyboardEvent('keydown', {
      key: data.key, altKey: data.altKey === true, ctrlKey: data.ctrlKey === true,
      metaKey: data.metaKey === true, shiftKey: data.shiftKey === true, repeat: data.repeat === true,
      bubbles: true, cancelable: true,
    })
    const intent = keyIntent(forwarded, 'reader')
    if (!intent || !DOCUMENT_KEY_INTENTS.includes(intent)) return
    // Bubble through the same app handler; keys never focus a document.
    this.track.dispatchEvent(forwarded)
  }
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
