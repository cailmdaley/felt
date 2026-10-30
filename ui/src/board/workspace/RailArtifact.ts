import { buildFileViewer, disposeFileViewer } from '../FileViewerPanel.js'
import { DOCUMENT_KEY_INTENTS, keyIntent } from '../keymap.js'
import type { DocumentKey } from './DocumentBridge.js'
import type { DocKey, WorkspaceDocument } from './documents.js'
import { headerIcon } from './headerIcon.js'

const OPEN_STORAGE = 'shuttle:workspace:rail-artifact-open'
/** The narrowest width an artifact lays out at; a narrower rail shows that layout in miniature. */
export const ARTIFACT_VIRTUAL_MIN = 720
/** The miniature's height per unit of rail width: a page, taller than it is wide. */
export const ARTIFACT_ASPECT = 1.4
/** Below this the miniature stops being worth scrolling. */
export const ARTIFACT_MIN_HEIGHT = 180
/** What the rail keeps beneath the artifact for each region it also holds: a heading and a row or two. */
export const ARTIFACT_RESERVE = 96

export interface RailArtifactGeometry {
  /** The width the page lays out at. */
  virtualWidth: number
  /** Rail pixels per page pixel. */
  scale: number
  /** The miniature's height in rail pixels. */
  height: number
}

/**
 * The artifact's place at the head of the rail. The page lays out at
 * `max(width, 720)` and is scaled to the rail's width, so widening the rail
 * grows it toward 1:1. Its height follows the width as a page would, capped so
 * `reserve` pixels of the rail stay below it, and never less than a useful
 * minimum unless the rail itself is shorter. With nothing below
 * (`reserve === 0`) it takes the rest of the rail.
 */
export function railArtifactGeometry(width: number, available: number, reserve: number): RailArtifactGeometry {
  const w = Math.max(1, Math.floor(width))
  const virtualWidth = Math.max(w, ARTIFACT_VIRTUAL_MIN)
  const room = Math.max(0, Math.floor(available))
  const wanted = reserve > 0 ? Math.min(Math.round(w * ARTIFACT_ASPECT), room - reserve) : room
  const height = Math.min(room, Math.max(ARTIFACT_MIN_HEIGHT, wanted))
  return { virtualWidth, scale: w / virtualWidth, height }
}

/**
 * The open constitution's artifact, live, at the head of the rail: scrollable
 * and clickable in place, reloaded in place when the worker rewrites it, with
 * a heading that folds it and a control that opens the full page.
 */
export class RailArtifact {
  readonly el = document.createElement('section')
  private readonly head = document.createElement('div')
  private readonly toggle = document.createElement('button')
  private readonly full = document.createElement('button')
  private readonly body = document.createElement('div')
  private doc: WorkspaceDocument | null = null
  private viewer: HTMLElement | null = null
  private live = false
  private expanded = true
  private openFull: ((key: DocKey) => void) | null = null
  private geometry: RailArtifactGeometry | null = null
  /** The artifact fills the stage: the section keeps its heading and stands down its page. */
  private onStage = false

  private readonly shuttleBase: string
  private readonly navigate: (source: WorkspaceDocument, href: string) => void
  /** The rail asks to be refitted when unfolding gives the body a size again. */
  onUnfold: () => void = () => {}
  /**
   * `navigate` follows the page's own links (relative and file links), as the
   * full page does; its reader keys reach the reader through the rail.
   */
  constructor(shuttleBase: string, navigate: (source: WorkspaceDocument, href: string) => void = () => {}) {
    this.shuttleBase = shuttleBase; this.navigate = navigate
    this.el.className = 'ws-rail-artifact'
    this.el.setAttribute('aria-label', 'Artifact')
    this.el.hidden = true
    this.head.className = 'ws-rail-artifact-head'
    this.toggle.type = 'button'
    this.toggle.className = 'ws-rail-artifact-toggle'
    this.toggle.textContent = 'Artifact'
    this.toggle.addEventListener('click', () => this.setExpanded(!this.expanded, true))
    this.full.type = 'button'
    this.full.className = 'ws-rail-artifact-full'
    this.full.innerHTML = headerIcon('open')
    this.full.title = 'Open the full artifact'
    this.full.setAttribute('aria-label', 'Open the full artifact')
    this.full.addEventListener('click', () => { if (this.doc) this.openFull?.(this.doc.key) })
    this.head.append(this.toggle, this.full)
    this.body.className = 'ws-rail-artifact-body'
    this.el.append(this.head, this.body)
    try { this.expanded = localStorage.getItem(OPEN_STORAGE) !== 'false' } catch { /* Storage is optional. */ }
    this.setExpanded(this.expanded, false)
  }

  /** Whether there is an artifact to show; independent of whether it is loaded. */
  get present(): boolean { return this.doc !== null }
  get isExpanded(): boolean { return this.expanded }

  /**
   * The document the section stands for, or none; a different one replaces the
   * page. While it fills the stage (`onStage`) the heading stays, so the rail
   * keeps its shape, and the page is not drawn twice.
   */
  show(doc: WorkspaceDocument | null, openFull: (key: DocKey) => void, onStage = false): void {
    this.openFull = openFull
    if (onStage !== this.onStage) {
      this.onStage = onStage
      this.el.classList.toggle('ws-rail-artifact-staged', onStage)
      this.full.hidden = onStage
      this.toggle.disabled = onStage
      this.paintBody()
    }
    if (doc?.key !== this.doc?.key || doc?.owner !== this.doc?.owner || doc?.path !== this.doc?.path) {
      this.unmount()
      this.doc = doc
    } else if (doc) this.doc = doc
    this.el.hidden = !this.doc
    this.mountIfWanted()
  }

  /** Load the page while the rail stands open; unload it when the rail closes. */
  setLive(live: boolean): void {
    this.live = live
    if (live) this.mountIfWanted()
    else this.unmount()
  }

  /**
   * Size the miniature to the rail: `available` is the rail's whole height,
   * `reserve` what must stay visible beneath the section. A repeat of the same
   * geometry writes nothing.
   */
  resize(available: number, reserve: number): void {
    if (this.el.hidden || this.body.hidden) return
    const width = this.body.clientWidth
    if (!width) return
    // The section's own chrome (padding, heading, border) comes out of the room first.
    const chrome = this.el.offsetHeight - this.body.offsetHeight
    const next = railArtifactGeometry(width, available - chrome, reserve)
    const prev = this.geometry
    if (prev && prev.height === next.height && prev.virtualWidth === next.virtualWidth && prev.scale === next.scale) return
    this.geometry = next
    this.body.style.height = `${next.height}px`
    this.el.style.setProperty('--ws-artifact-virtual-width', `${next.virtualWidth}px`)
    this.el.style.setProperty('--ws-artifact-scale', String(next.scale))
    this.el.dataset.scale = next.scale.toFixed(3)
  }

  dispose(): void { this.unmount(); this.el.remove() }

  private setExpanded(expanded: boolean, persist: boolean): void {
    this.expanded = expanded
    this.toggle.setAttribute('aria-expanded', String(expanded))
    this.el.classList.toggle('ws-rail-artifact-folded', !expanded)
    this.paintBody()
    if (persist) try { localStorage.setItem(OPEN_STORAGE, String(expanded)) } catch { /* Storage is optional. */ }
  }

  private paintBody(): void {
    const open = this.expanded && !this.onStage
    this.body.hidden = !open
    if (open) { this.mountIfWanted(); this.onUnfold() }
    else this.unmount()
  }

  private mountIfWanted(): void {
    const doc = this.doc
    if (!doc || !this.live || !this.expanded || this.onStage || this.viewer) return
    // The full page's own viewer: the same sandbox, the same shared live watcher, and its scroll kept across rewrites.
    const viewer = buildFileViewer(this.shuttleBase, doc.path, doc.owner, undefined, undefined, {
      active: true, quietLoading: true,
      onNavigate: href => this.navigate(doc, href),
      onDocumentKey: key => this.forwardKey(key),
    })
    viewer.classList.add('ws-rail-artifact-page')
    this.viewer = viewer
    this.body.replaceChildren(viewer)
  }

  /** A reader key pressed inside the page bubbles out through the rail, as one pressed on the stage would. */
  private forwardKey(data: DocumentKey): void {
    const forwarded = new KeyboardEvent('keydown', {
      key: data.key, altKey: data.altKey === true, ctrlKey: data.ctrlKey === true,
      metaKey: data.metaKey === true, shiftKey: data.shiftKey === true, repeat: data.repeat === true,
      bubbles: true, cancelable: true,
    })
    const intent = keyIntent(forwarded, 'reader')
    if (!intent || !DOCUMENT_KEY_INTENTS.includes(intent)) return
    this.el.dispatchEvent(forwarded)
  }

  private unmount(): void {
    if (!this.viewer) return
    disposeFileViewer(this.viewer)
    this.viewer.remove()
    this.viewer = null
  }
}
