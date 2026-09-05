import './gestures.css'

import { cacheBustUrl, showToast } from '../utils.js'
import {
  boxInSpace,
  pointInRect,
  pointInSpace,
  roundBox,
  scaleFromTransform,
  type CoordinateSpace,
  type GestureBox,
  type RectLike,
} from './coordinates.js'
import { CONTAINER_COVERAGE, pickTarget, planPress, type HitOutcome } from './policy.js'
import {
  coalesceGestures,
  serializeGestures,
  type GestureLocation,
  type GestureRecord,
} from './serializer.js'

const MOVE_TOLERANCE = 5
/** Things the deck drives itself — gestures never grab them. */
const INTERACTIVE_SELECTOR = 'input,textarea,select,button,a,summary,details,video,audio,[contenteditable="true"]'
const TOGGLE_HOTKEY = 'g'
const BATCH_HOTKEY = ']'
const POLL_MS = 3_000
const MIN_SIZE = 18

const FRAME_STYLE = `
.kbn-gesture-overlay { position: absolute; inset: 0; z-index: 2147483000; pointer-events: none; }
.kbn-gesture-selection { position: absolute; box-sizing: border-box; border: 2px solid #2f7d6f; background: rgba(47,125,111,.08); pointer-events: none; }
.kbn-gesture-marquee { position: absolute; box-sizing: border-box; border: 1px dashed #2f7d6f; background: rgba(47,125,111,.08); pointer-events: none; }
.kbn-gesture-handle { position: absolute; width: 10px; height: 10px; box-sizing: border-box; padding: 0; border: 1px solid #fffdf6; border-radius: 2px; background: #2f7d6f; pointer-events: auto; cursor: nwse-resize; }
.kbn-gesture-handle-n, .kbn-gesture-handle-s { left: 50%; transform: translateX(-50%); cursor: ns-resize; }
.kbn-gesture-handle-e, .kbn-gesture-handle-w { top: 50%; transform: translateY(-50%); cursor: ew-resize; }
.kbn-gesture-handle-nw, .kbn-gesture-handle-se { cursor: nwse-resize; }
.kbn-gesture-handle-ne, .kbn-gesture-handle-sw { cursor: nesw-resize; }
.kbn-gesture-handle-n, .kbn-gesture-handle-ne, .kbn-gesture-handle-nw { top: -6px; }
.kbn-gesture-handle-e, .kbn-gesture-handle-ne, .kbn-gesture-handle-se { right: -6px; }
.kbn-gesture-handle-s, .kbn-gesture-handle-se, .kbn-gesture-handle-sw { bottom: -6px; }
.kbn-gesture-handle-w, .kbn-gesture-handle-nw, .kbn-gesture-handle-sw { left: -6px; }
.kbn-gesture-comment { position: absolute; pointer-events: auto; transform: translate(-4px, -4px); cursor: move; }
.kbn-gesture-comment::before { content: ''; display: block; width: 9px; height: 9px; border: 2px solid #9a4a35; border-radius: 50%; background: #fffdf6; box-shadow: 0 1px 4px rgba(27,22,17,.25); }
.kbn-gesture-comment-input { pointer-events: auto; width: 210px; box-sizing: border-box; margin: 6px 0 0 9px; padding: 5px 7px; border: 1px solid #9a7b35; border-radius: 3px; background: #fffdf6; color: #2e2a26; font: 14px/1.2 sans-serif; box-shadow: 0 2px 8px rgba(27,22,17,.18); }
.kbn-gesture-editing { outline: 2px solid rgba(194,150,59,.7); outline-offset: 2px; }
`

type RevealApi = {
  getConfig?: () => { width?: number; height?: number }
  getScale?: () => number
  getIndices?: () => { h?: number; v?: number }
}

type RuntimeSpace = CoordinateSpace & { root: HTMLElement }

export interface GestureLayerOptions {
  shuttleBase: string
  fiberId?: string
  filePath?: string
  sourceUrl?: string
}

interface Selection {
  target: HTMLElement
  space: RuntimeSpace
  boxEl: HTMLElement
}

interface GroupSelection {
  targets: HTMLElement[]
  space: RuntimeSpace
  boxEl: HTMLElement
}

interface OriginalElement {
  box: GestureBox
  text: string
  fingerprint: string
}

interface Marquee {
  pointerId: number
  x: number
  y: number
  space: RuntimeSpace
  boxEl: HTMLElement
  active: boolean
}

interface CommentManipulation {
  marker: HTMLElement
  recordId: string
  pointerId: number
  x: number
  y: number
  space: RuntimeSpace
  before: { x: number; y: number }
  point: { x: number; y: number }
}

interface GroupManipulation {
  targets: HTMLElement[]
  mode: 'move' | 'resize'
  direction?: string
  pointerId: number
  x: number
  y: number
  space: RuntimeSpace
  restore: Map<HTMLElement, MemberStyle>
  /** Member geometry at grab time, in the group's coordinate space. */
  boxes: Map<HTMLElement, GestureBox>
  before: GestureBox
  after: GestureBox
  fingerprints: string[]
  delta: { x: number; y: number }
}

interface MemberStyle {
  transform: string
}

interface Manipulation {
  target: HTMLElement
  mode: 'move' | 'resize'
  direction?: string
  pointerId: number
  x: number
  y: number
  space: RuntimeSpace
  before: GestureBox
  recordBefore: GestureBox
  transform: string
  position: string
  left: string
  top: string
}

const liveLayers = new WeakMap<HTMLIFrameElement, GestureLayer>()

/** Add the gesture surface to a same-origin document. The layer is deliberately
 * an iframe companion rather than a document script: rendered files remain
 * untouched, and a layer disappears with the frame that hosts it. */
export function installGestureLayer(
  frame: HTMLIFrameElement,
  options: GestureLayerOptions,
): GestureLayer {
  const existing = liveLayers.get(frame)
  if (existing) return existing
  const layer = new GestureLayer(frame, options)
  liveLayers.set(frame, layer)
  return layer
}

export class GestureLayer {
  private readonly frame: HTMLIFrameElement
  private readonly options: GestureLayerOptions
  private readonly sourceUrl: string
  private host: HTMLElement | null = null
  private chrome: HTMLElement | null = null
  private panel: HTMLElement | null = null
  private toggleButton: HTMLButtonElement | null = null
  private batchButton: HTMLButtonElement | null = null
  private sendButton: HTMLButtonElement | null = null
  private statusEl: HTMLElement | null = null
  private enabled = false
  private batchExpanded = false
  private records: GestureRecord[] = []
  private doc: Document | null = null
  private overlay: HTMLElement | null = null
  private selection: Selection | GroupSelection | null = null
  private marquee: Marquee | null = null
  private commentManipulation: CommentManipulation | null = null
  private manipulation: Manipulation | null = null
  private groupManipulation: GroupManipulation | null = null
  private readonly originalElements = new Map<string, OriginalElement>()
  private readonly pristineHeadings = new WeakMap<HTMLElement, string>()
  private editing: { element: HTMLElement; before: string; finish: () => void } | null = null
  private pollTimer: number | null = null
  private pollBusy = false
  private validator: string | null = null
  private sending = false
  private fallbackText: string | null = null
  private suppressClick = false
  private nextId = 1
  private readonly onFrameLoad = (): void => this.connectDocument()
  private readonly onPointerDown = (event: PointerEvent): void => this.pointerDown(event)
  private readonly onPointerMove = (event: PointerEvent): void => this.pointerMove(event)
  private readonly onPointerUp = (event: PointerEvent): void => this.pointerUp(event)
  private readonly onPointerCancel = (event: PointerEvent): void => this.pointerCancel(event)
  private readonly onClick = (event: MouseEvent): void => this.click(event)
  private readonly onDoubleClick = (event: MouseEvent): void => this.doubleClick(event)
  private readonly onKeyDown = (event: KeyboardEvent): void => this.keyDown(event)
  private readonly onParentKeyDown = (event: KeyboardEvent): void => {
    if (this.parentOwnsFocus()) this.keyDown(event)
  }

  constructor(frame: HTMLIFrameElement, options: GestureLayerOptions) {
    this.frame = frame
    this.options = options
    this.sourceUrl = options.sourceUrl ?? frame.getAttribute('src') ?? frame.src
    this.mountChrome()
    document.addEventListener('keydown', this.onParentKeyDown, true)
    frame.addEventListener('load', this.onFrameLoad)
    this.connectDocument()
  }

  destroy(): void {
    if (this.enabled) this.setEnabled(false)
    else this.stopPolling()
    document.removeEventListener('keydown', this.onParentKeyDown, true)
    this.frame.removeEventListener('load', this.onFrameLoad)
    this.chrome?.remove()
    this.panel?.remove()
    this.chrome = null
    this.panel = null
    this.host?.classList.remove('kbn-gesture-host')
    liveLayers.delete(this.frame)
  }

  private mountChrome(): void {
    const host = this.frame.parentElement
    if (!host) return
    this.host = host
    host.classList.add('kbn-gesture-host')

    const chrome = document.createElement('div')
    chrome.className = 'kbn-gesture-chrome'
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'kbn-gesture-toggle'
    toggle.textContent = 'gestures'
    toggle.setAttribute('aria-pressed', 'false')
    toggle.title = 'G: gestures on/off · while on, drag an element to move it, its handles to resize · '
      + 'drag the background to select a group · double-click the background to leave a comment · ]: batch'
    toggle.addEventListener('click', (event) => {
      event.stopPropagation()
      this.setEnabled(!this.enabled)
    })
    const batch = document.createElement('button')
    batch.type = 'button'
    batch.className = 'kbn-gesture-badge'
    batch.setAttribute('aria-expanded', 'false')
    batch.title = 'Expand gesture batch (])'
    batch.addEventListener('click', (event) => {
      event.stopPropagation()
      this.batchExpanded = !this.batchExpanded
      this.updateChrome()
    })

    const send = document.createElement('button')
    send.type = 'button'
    send.className = 'kbn-gesture-send'
    send.textContent = 'Send'
    send.title = 'Send the gesture batch to the live worker'
    send.disabled = true
    send.addEventListener('click', (event) => {
      event.stopPropagation()
      void this.send()
    })
    chrome.append(toggle, batch, send)

    const panel = document.createElement('aside')
    panel.className = 'kbn-gesture-panel'
    panel.hidden = true
    const status = document.createElement('div')
    status.className = 'kbn-gesture-status'
    panel.append(status)
    host.append(chrome, panel)
    this.chrome = chrome
    this.panel = panel
    this.toggleButton = toggle
    this.batchButton = batch
    this.sendButton = send
    this.statusEl = status
  }

  private connectDocument(): void {
    try {
      const doc = this.frame.contentDocument
      if (!doc) return
      if (this.doc === doc) return
      if (this.doc) this.clearOverlay()
      this.disconnectDocument()
      this.doc = doc
      for (const section of doc.querySelectorAll<HTMLElement>('section')) {
        this.pristineHeadings.set(section, section.querySelector<HTMLElement>('h1,h2,h3,h4,h5,h6')?.textContent?.trim() ?? '')
      }
      if (!doc.querySelector('style[data-kbn-gesture-style]')) {
        const style = doc.createElement('style')
        style.dataset.kbnGestureStyle = '1'
        style.textContent = FRAME_STYLE
        doc.head?.append(style)
      }
      doc.addEventListener('pointerdown', this.onPointerDown, true)
      doc.addEventListener('pointermove', this.onPointerMove, true)
      doc.addEventListener('pointerup', this.onPointerUp, true)
      doc.addEventListener('pointercancel', this.onPointerCancel, true)
      doc.addEventListener('click', this.onClick, true)
      doc.addEventListener('dblclick', this.onDoubleClick, true)
      doc.addEventListener('keydown', this.onKeyDown, true)
    } catch {
      this.doc = null
    }
  }

  private disconnectDocument(): void {
    const doc = this.doc
    if (!doc) return
    doc.removeEventListener('pointerdown', this.onPointerDown, true)
    doc.removeEventListener('pointermove', this.onPointerMove, true)
    doc.removeEventListener('pointerup', this.onPointerUp, true)
    doc.removeEventListener('pointercancel', this.onPointerCancel, true)
    doc.removeEventListener('click', this.onClick, true)
    doc.removeEventListener('dblclick', this.onDoubleClick, true)
    doc.removeEventListener('keydown', this.onKeyDown, true)
    this.doc = null
  }

  private setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (enabled) {
      this.connectDocument()
      this.startPolling()
    } else {
      this.batchExpanded = false
      this.stopPolling()
      this.cancelInteractions()
      this.clearOverlay()
    }
    this.updateChrome()
  }

  private updateChrome(): void {
    this.toggleButton?.setAttribute('aria-pressed', String(this.enabled))
    if (this.toggleButton) this.toggleButton.textContent = this.enabled ? 'gestures on' : 'gestures'
    if (this.batchButton) {
      this.batchButton.hidden = !this.enabled
      this.batchButton.textContent = String(this.records.length)
      this.batchButton.setAttribute('aria-expanded', String(this.batchExpanded))
      this.batchButton.setAttribute('aria-label', `${this.records.length} unsent gesture${this.records.length === 1 ? '' : 's'}`)
    }
    if (this.sendButton) {
      this.sendButton.hidden = !this.enabled
      this.sendButton.disabled = !this.enabled || this.records.length === 0 || this.sending
    }
    if (this.panel) this.panel.hidden = !this.enabled || !this.batchExpanded
    this.renderBatch()
  }

  private pointerDown(event: PointerEvent): void {
    if (!this.enabled || event.button !== 0) return
    const target = this.elementTarget(event.target)
    if (!target) return

    const handle = target.closest<HTMLElement>('[data-gesture-handle]')
    if (handle) {
      event.preventDefault()
      event.stopPropagation()
      const direction = handle.dataset.gestureHandle
      const selection = this.selection
      if (selection && 'target' in selection) this.beginManipulation(selection.target, 'resize', direction, event)
      else if (selection) this.beginGroupManipulation(selection, 'resize', direction, event)
      return
    }

    const comment = target.closest<HTMLElement>('.kbn-gesture-comment')
    if (comment && !target.matches('input,textarea,button')) {
      const recordId = comment.dataset.gestureId
      const record = this.records.find((item) => item.id === recordId && item.kind === 'comment')
      const space = this.runtimeSpace()
      if (record?.point && space) {
        event.preventDefault()
        event.stopPropagation()
        this.beginCommentManipulation(comment, record, space, event)
      }
      return
    }
    if (target.closest('.kbn-gesture-overlay')) return

    const space = this.runtimeSpace()
    if (!space) return

    const group = this.groupUnderPointer(event)
    const single = this.selection && 'target' in this.selection ? this.selection : null
    const hit = this.hitTest(event, space)
    const hitElement = hit.element
    const plan = planPress({
      hit: hit.outcome,
      insideGroupBox: Boolean(group),
      insideSelectionBox: Boolean(single) && this.pointInSelection(event),
      onSelection: Boolean(single && hitElement && (hitElement === single.target || single.target.contains(hitElement))),
    })
    if (plan === 'none' || plan === 'marquee') {
      if (plan === 'marquee') this.beginMarquee(space, event)
      return
    }

    event.preventDefault()
    event.stopPropagation()
    if (plan === 'group' && group) {
      this.beginGroupManipulation(group, 'move', undefined, event)
      return
    }
    const moving = plan === 'selection' ? single?.target ?? hitElement : hitElement
    if (!moving) return
    this.select(moving, space)
    this.beginManipulation(moving, 'move', undefined, event)
  }

  private pointerMove(event: PointerEvent): void {
    if (this.marquee?.pointerId === event.pointerId) {
      this.updateMarquee(event)
      return
    }
    if (this.commentManipulation?.pointerId === event.pointerId) {
      event.preventDefault()
      event.stopPropagation()
      this.applyCommentManipulation(event)
      return
    }
    if (this.groupManipulation?.pointerId === event.pointerId) {
      event.preventDefault()
      event.stopPropagation()
      this.applyGroupManipulation(event)
      return
    }
    if (this.manipulation?.pointerId === event.pointerId) {
      event.preventDefault()
      event.stopPropagation()
      this.applyManipulation(event)
    }
  }

  private pointerUp(event: PointerEvent): void {
    if (this.marquee?.pointerId === event.pointerId) {
      this.suppressClick = this.finishMarquee(event)
      return
    }
    if (this.commentManipulation?.pointerId === event.pointerId) {
      event.preventDefault()
      event.stopPropagation()
      this.finishCommentManipulation()
      this.suppressClick = true
    } else if (this.groupManipulation?.pointerId === event.pointerId) {
      event.preventDefault()
      event.stopPropagation()
      this.finishGroupManipulation()
      this.suppressClick = true
    } else if (this.manipulation?.pointerId === event.pointerId) {
      event.preventDefault()
      event.stopPropagation()
      this.finishManipulation()
      this.suppressClick = true
    }
  }

  private pointerCancel(event: PointerEvent): void {
    if (this.marquee?.pointerId === event.pointerId) this.cancelMarquee()
    if (this.commentManipulation?.pointerId === event.pointerId) this.commentManipulation = null
    if (this.groupManipulation?.pointerId === event.pointerId) this.groupManipulation = null
    if (this.manipulation?.pointerId === event.pointerId) this.manipulation = null
  }

  private click(event: MouseEvent): void {
    if (!this.enabled) return
    if (this.suppressClick) {
      this.suppressClick = false
      event.preventDefault()
      event.stopPropagation()
      return
    }
    const target = this.elementTarget(event.target)
    if (!target || target.closest('.kbn-gesture-overlay')) return
    const space = this.runtimeSpace()
    if (!space) return
    // Clicking the background drops the selection; clicking inside it keeps it.
    if (this.hitTest(event, space).outcome.kind !== 'empty') return
    if (!this.pointInSelection(event)) this.removeSelection()
  }

  private doubleClick(event: MouseEvent): void {
    if (!this.enabled) return
    const target = this.elementTarget(event.target)
    if (!target || target.closest('.kbn-gesture-overlay')) return
    const space = this.runtimeSpace()
    if (!space) return
    const hit = this.hitTest(event, space)
    if (hit.element) {
      const textTarget = this.textTarget(hit.element)
      if (textTarget) {
        event.preventDefault()
        event.stopPropagation()
        this.beginTextEdit(textTarget)
      }
      return
    }
    if (hit.outcome.kind !== 'empty') return
    event.preventDefault()
    event.stopPropagation()
    this.placeComment(space, event.clientX, event.clientY)
  }

  private keyDown(event: KeyboardEvent): void {
    if (this.isEditableTarget(event.target)) return
    const key = event.key.toLowerCase()
    if (key === TOGGLE_HOTKEY) {
      event.preventDefault()
      event.stopPropagation()
      this.setEnabled(!this.enabled)
      return
    }
    if (!this.enabled) return
    if (key === BATCH_HOTKEY) {
      event.preventDefault()
      event.stopPropagation()
      this.batchExpanded = !this.batchExpanded
      this.updateChrome()
      return
    }
    if (event.key !== 'Escape') return
    if (this.editing) {
      event.preventDefault()
      event.stopPropagation()
      this.editing.finish()
      return
    }
    this.removeSelection()
    this.updateChrome()
  }

  private parentOwnsFocus(): boolean {
    const active = document.activeElement
    return active === this.frame || Boolean(this.host?.contains(active))
  }

  private isEditableTarget(target: EventTarget | null): boolean {
    const element = this.elementTarget(target)
    return Boolean(element?.matches('input,textarea,select,[contenteditable="true"],.kbn-gesture-comment-input') || element?.closest('input,textarea,select,[contenteditable="true"],.kbn-gesture-comment-input'))
  }

  private beginManipulation(
    target: HTMLElement,
    mode: 'move' | 'resize',
    direction: string | undefined,
    event: { pointerId: number; clientX: number; clientY: number },
  ): void {
    const selected = this.selection
    const space = selected && 'target' in selected && selected.target === target
      ? selected.space
      : this.runtimeSpace()
    if (!space) return
    const before = roundBox(boxInSpace(target.getBoundingClientRect(), space, this.scrollX(), this.scrollY()))
    const original = this.captureOriginal(target, space)
    this.manipulation = {
      target,
      mode,
      direction,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      space,
      before,
      recordBefore: original.box,
      transform: target.style.transform,
      position: target.style.position,
      left: target.style.left,
      top: target.style.top,
    }
  }

  private applyManipulation(event: PointerEvent): void {
    const move = this.manipulation
    if (!move || move.pointerId !== event.pointerId) return
    const factor = move.space.kind === 'slide' ? move.space.scale : 1
    const dx = (event.clientX - move.x) / factor
    const dy = (event.clientY - move.y) / factor
    if (move.mode === 'move') {
      const translation = `translate(${dx}px, ${dy}px)`
      move.target.style.transform = [move.transform, translation].filter(Boolean).join(' ')
    } else {
      const direction = move.direction ?? ''
      const west = direction.includes('w')
      const north = direction.includes('n')
      const east = direction.includes('e')
      const south = direction.includes('s')
      const width = Math.max(MIN_SIZE, move.before.width + (west ? -dx : east ? dx : 0))
      const height = Math.max(MIN_SIZE, move.before.height + (north ? -dy : south ? dy : 0))
      move.target.style.position = move.position || 'relative'
      move.target.style.width = `${width}px`
      move.target.style.height = `${height}px`
      move.target.style.maxWidth = 'none'
      if (west) move.target.style.left = `${(parseFloat(move.left) || 0) + dx}px`
      if (north) move.target.style.top = `${(parseFloat(move.top) || 0) + dy}px`
    }
    this.renderSelection()
  }

  private finishManipulation(): void {
    const move = this.manipulation
    this.manipulation = null
    if (!move) return
    const after = roundBox(boxInSpace(move.target.getBoundingClientRect(), move.space, this.scrollX(), this.scrollY()))
    this.pushRecord({
      id: this.id(),
      kind: move.mode,
      location: this.location(move.space),
      fingerprint: this.originalFor(move.target, move.space).fingerprint,
      coalesceKey: this.elementKey(move.target, move.space),
      beforeBox: move.recordBefore,
      afterBox: after,
    })
  }

  private beginMarquee(space: RuntimeSpace, event: PointerEvent): void {
    const overlay = this.ensureOverlay(space)
    const boxEl = this.doc?.createElement('div')
    if (!boxEl) return
    boxEl.className = 'kbn-gesture-marquee'
    overlay.append(boxEl)
    this.marquee = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      space,
      boxEl,
      active: false,
    }
  }

  private updateMarquee(event: PointerEvent): void {
    const marquee = this.marquee
    if (!marquee || marquee.pointerId !== event.pointerId) return
    const active = Math.hypot(event.clientX - marquee.x, event.clientY - marquee.y) >= MOVE_TOLERANCE
    if (!active) return
    marquee.active = true
    event.preventDefault()
    event.stopPropagation()
    const start = pointInSpace(marquee.x, marquee.y, marquee.space, this.scrollX(), this.scrollY())
    const end = pointInSpace(event.clientX, event.clientY, marquee.space, this.scrollX(), this.scrollY())
    const box = normalizedBox(start.x, start.y, end.x, end.y)
    marquee.boxEl.style.left = `${box.x}px`
    marquee.boxEl.style.top = `${box.y}px`
    marquee.boxEl.style.width = `${box.width}px`
    marquee.boxEl.style.height = `${box.height}px`
  }

  private finishMarquee(event: PointerEvent): boolean {
    const marquee = this.marquee
    if (!marquee || marquee.pointerId !== event.pointerId) return false
    const active = marquee.active
    if (active) {
      const start = pointInSpace(marquee.x, marquee.y, marquee.space, this.scrollX(), this.scrollY())
      const end = pointInSpace(event.clientX, event.clientY, marquee.space, this.scrollX(), this.scrollY())
      const box = normalizedBox(start.x, start.y, end.x, end.y)
      const targets = this.selectableElements(marquee.space).filter((element) =>
        boxesIntersect(box, boxInSpace(element.getBoundingClientRect(), marquee.space, this.scrollX(), this.scrollY())),
      )
      if (targets.length > 0) this.selectGroup(targets, marquee.space)
      else this.removeSelection()
      event.preventDefault()
      event.stopPropagation()
    }
    marquee.boxEl.remove()
    this.marquee = null
    return active
  }

  private cancelMarquee(): void {
    this.marquee?.boxEl.remove()
    this.marquee = null
  }

  private selectableElements(space: RuntimeSpace): HTMLElement[] {
    const leafTags = new Set(['img', 'video', 'canvas', 'svg', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'figcaption', 'blockquote', 'td', 'th', 'caption'])
    const limit = area(space.root.getBoundingClientRect()) * CONTAINER_COVERAGE
    return [...space.root.querySelectorAll<HTMLElement>('*')].filter((element) => {
      if (element.closest('.kbn-gesture-overlay') || this.isStructural(element)) return false
      if (element.matches(`script,style,${INTERACTIVE_SELECTOR}`)) return false
      if (!leafTags.has(element.tagName.toLowerCase()) && element.children.length > 0) return false
      const box = area(element.getBoundingClientRect())
      // A marquee is for content, not for the container the content sits in.
      return box > 0 && box < limit
    })
  }

  /** The selection outline plus its eight resize handles. `null` when the
   *  frame document has gone away mid-build. */
  private selectionBox(labelPrefix: string): HTMLElement | null {
    const boxEl = this.doc?.createElement('div')
    if (!boxEl) return null
    boxEl.className = 'kbn-gesture-selection'
    for (const direction of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const handle = this.doc?.createElement('button')
      if (!handle) return null
      handle.type = 'button'
      handle.className = `kbn-gesture-handle kbn-gesture-handle-${direction}`
      handle.dataset.gestureHandle = direction
      handle.setAttribute('aria-label', `${labelPrefix} ${direction}`)
      boxEl.append(handle)
    }
    return boxEl
  }

  private selectGroup(targets: HTMLElement[], space: RuntimeSpace): void {
    this.removeSelection()
    const boxEl = this.selectionBox('Resize group')
    if (!boxEl) return
    this.ensureOverlay(space).append(boxEl)
    this.selection = { targets, space, boxEl }
    this.renderSelection()
  }

  /** The group selection whose outline covers this pointer, if any. */
  private groupUnderPointer(event: { clientX: number; clientY: number }): GroupSelection | undefined {
    const selection = this.selection
    if (!selection || 'target' in selection) return undefined
    return pointInRect(event.clientX, event.clientY, rectLike(selection.boxEl.getBoundingClientRect()))
      ? selection
      : undefined
  }

  /** Clicks inside any selection outline keep it; only outside clicks drop it. */
  private pointInSelection(event: { clientX: number; clientY: number }): boolean {
    const selection = this.selection
    if (!selection) return false
    return pointInRect(event.clientX, event.clientY, rectLike(selection.boxEl.getBoundingClientRect()))
  }

  private beginGroupManipulation(
    group: GroupSelection,
    mode: 'move' | 'resize',
    direction: string | undefined,
    event: { pointerId: number; clientX: number; clientY: number },
  ): void {
    this.manipulation = null
    const before = boundingBox(group.targets, group.space, this.scrollX(), this.scrollY())
    this.groupManipulation = {
      targets: group.targets,
      mode,
      direction,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      space: group.space,
      restore: new Map(group.targets.map((target) => [target, memberStyle(target)])),
      boxes: new Map(group.targets.map((target) => [
        target,
        boxInSpace(target.getBoundingClientRect(), group.space, this.scrollX(), this.scrollY()),
      ])),
      before,
      after: before,
      fingerprints: group.targets.map((target) => this.captureOriginal(target, group.space).fingerprint),
      delta: { x: 0, y: 0 },
    }
  }

  private applyGroupManipulation(event: PointerEvent): void {
    const move = this.groupManipulation
    if (!move || move.pointerId !== event.pointerId) return
    const factor = move.space.kind === 'slide' ? move.space.scale : 1
    const dx = (event.clientX - move.x) / factor
    const dy = (event.clientY - move.y) / factor
    if (move.mode === 'move') {
      move.delta = { x: dx, y: dy }
      move.after = { ...move.before, x: move.before.x + dx, y: move.before.y + dy }
      for (const target of move.targets) {
        const restore = move.restore.get(target)?.transform
        target.style.transform = [restore, `translate(${dx}px, ${dy}px)`].filter(Boolean).join(' ')
      }
    } else {
      move.after = resizedBox(move.before, move.direction ?? '', dx, dy)
      const scaleX = move.before.width > 0 ? move.after.width / move.before.width : 1
      const scaleY = move.before.height > 0 ? move.after.height / move.before.height : 1
      // Members keep their place within the group: the box scales, and each
      // member's offset and size scale with it.
      for (const target of move.targets) {
        const box = move.boxes.get(target)
        const restore = move.restore.get(target)
        if (!box || !restore) continue
        const x = move.after.x + (box.x - move.before.x) * scaleX
        const y = move.after.y + (box.y - move.before.y) * scaleY
        target.style.transform = [restore.transform, `translate(${x - box.x}px, ${y - box.y}px)`].filter(Boolean).join(' ')
        target.style.width = `${Math.max(MIN_SIZE, box.width * scaleX)}px`
        target.style.height = `${Math.max(MIN_SIZE, box.height * scaleY)}px`
        target.style.maxWidth = 'none'
      }
    }
    this.renderSelection()
  }

  private finishGroupManipulation(): void {
    const move = this.groupManipulation
    this.groupManipulation = null
    if (!move) return
    if (move.mode === 'move') {
      if (Math.abs(move.delta.x) <= 2 && Math.abs(move.delta.y) <= 2) return
      this.pushRecord({
        id: this.id(),
        kind: 'group',
        location: this.location(move.space),
        members: move.fingerprints,
        delta: move.delta,
      })
      return
    }
    const before = roundBox(move.before)
    const after = roundBox(boundingBox(move.targets, move.space, this.scrollX(), this.scrollY()))
    if (Math.abs(after.width - before.width) <= 2 && Math.abs(after.height - before.height) <= 2
      && Math.abs(after.x - before.x) <= 2 && Math.abs(after.y - before.y) <= 2) return
    this.pushRecord({
      id: this.id(),
      kind: 'group',
      location: this.location(move.space),
      members: move.fingerprints,
      beforeBox: before,
      afterBox: after,
    })
  }

  private beginCommentManipulation(marker: HTMLElement, record: GestureRecord, space: RuntimeSpace, event: PointerEvent): void {
    if (!record.point) return
    this.commentManipulation = {
      marker,
      recordId: record.id,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      space,
      before: record.point,
      point: record.point,
    }
  }

  private applyCommentManipulation(event: PointerEvent): void {
    const move = this.commentManipulation
    if (!move || move.pointerId !== event.pointerId) return
    const factor = move.space.kind === 'slide' ? move.space.scale : 1
    move.point = roundPoint({
      x: move.before.x + (event.clientX - move.x) / factor,
      y: move.before.y + (event.clientY - move.y) / factor,
    })
    move.marker.style.left = `${move.point.x}px`
    move.marker.style.top = `${move.point.y}px`
  }

  private finishCommentManipulation(): void {
    const move = this.commentManipulation
    this.commentManipulation = null
    if (!move) return
    if (Math.abs(move.point.x - move.before.x) <= 2 && Math.abs(move.point.y - move.before.y) <= 2) {
      move.marker.style.left = `${move.before.x}px`
      move.marker.style.top = `${move.before.y}px`
      return
    }
    this.records = this.records.map((record) => record.id === move.recordId ? { ...record, point: move.point } : record)
    this.updateChrome()
  }

  private select(target: HTMLElement, space: RuntimeSpace): void {
    if (this.selection && 'target' in this.selection && this.selection.target === target) {
      this.renderSelection()
      return
    }
    this.removeSelection()
    const boxEl = this.selectionBox('Resize')
    if (!boxEl) return
    this.ensureOverlay(space).append(boxEl)
    this.selection = { target, space, boxEl }
    this.renderSelection()
  }

  private renderSelection(): void {
    const selection = this.selection
    if (!selection) return
    const box = 'target' in selection
      ? roundBox(boxInSpace(selection.target.getBoundingClientRect(), selection.space, this.scrollX(), this.scrollY()))
      : boundingBox(selection.targets, selection.space, this.scrollX(), this.scrollY())
    const el = selection.boxEl
    el.style.left = `${box.x}px`
    el.style.top = `${box.y}px`
    el.style.width = `${Math.max(0, box.width)}px`
    el.style.height = `${Math.max(0, box.height)}px`
  }

  private removeSelection(): void {
    this.selection?.boxEl.remove()
    this.selection = null
  }

  private beginTextEdit(element: HTMLElement): void {
    if (this.editing?.element === element) return
    this.editing?.finish()
    const space = this.runtimeSpace()
    if (!space) return
    const original = this.captureOriginal(element, space)
    const before = element.textContent ?? ''
    element.contentEditable = 'true'
    element.classList.add('kbn-gesture-editing')
    const finish = (): void => {
      if (!this.editing || this.editing.element !== element) return
      element.contentEditable = 'false'
      element.classList.remove('kbn-gesture-editing')
      element.removeEventListener('blur', finish)
      const after = element.textContent ?? ''
      this.editing = null
      if (before !== after) {
        this.pushRecord({
          id: this.id(),
          kind: 'text',
          location: this.location(space),
          fingerprint: original.fingerprint,
          coalesceKey: this.elementKey(element, space),
          beforeText: original.text,
          afterText: after,
        })
      }
    }
    this.editing = { element, before, finish }
    element.addEventListener('blur', finish)
    element.focus()
    const range = this.doc?.createRange()
    if (range) {
      range.selectNodeContents(element)
      range.collapse(false)
      const selection = this.doc?.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
  }

  private placeComment(space: RuntimeSpace, clientX: number, clientY: number): void {
    const point = pointInSpace(clientX, clientY, space, this.scrollX(), this.scrollY())
    const overlay = this.ensureOverlay(space)
    const marker = this.doc?.createElement('div')
    if (!marker) return
    const id = this.id()
    marker.className = 'kbn-gesture-comment'
    marker.dataset.gestureId = id
    marker.style.left = `${point.x}px`
    marker.style.top = `${point.y}px`
    const input = this.doc?.createElement('input')
    if (!input) return
    input.type = 'text'
    input.placeholder = 'Comment…'
    input.className = 'kbn-gesture-comment-input'
    marker.append(input)
    overlay.append(marker)
    this.finishInlineInput(input, () => {
      const text = input.value.trim()
      if (text) {
        this.pushRecord({
          id,
          kind: 'comment',
          location: this.location(space),
          commentText: text,
          point: roundPoint(point),
          coalesceKey: id,
        })
      } else {
        marker.remove()
      }
    })
    input.focus()
  }

  private finishInlineInput(input: HTMLInputElement, finish: () => void): void {
    let closed = false
    const done = (): void => {
      if (closed) return
      closed = true
      input.removeEventListener('blur', done)
      input.removeEventListener('keydown', onKeyDown)
      finish()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closed = true
        input.removeEventListener('blur', done)
        input.removeEventListener('keydown', onKeyDown)
        input.remove()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        done()
      }
    }
    input.addEventListener('blur', done)
    input.addEventListener('keydown', onKeyDown)
  }

  private ensureOverlay(space: RuntimeSpace): HTMLElement {
    if (this.overlay?.parentElement !== space.root) {
      this.overlay?.remove()
      const overlay = space.root.ownerDocument.createElement('div')
      overlay.className = 'kbn-gesture-overlay'
      space.root.append(overlay)
      this.overlay = overlay
    }
    return this.overlay
  }

  private clearOverlay(): void {
    this.cancelInteractions()
    this.overlay?.remove()
    this.overlay = null
    this.selection = null
  }

  private cancelInteractions(): void {
    this.cancelMarquee()
    this.commentManipulation = null
    this.manipulation = null
    this.groupManipulation = null
    if (this.editing) {
      this.editing.finish()
      this.editing = null
    }
  }

  private pushRecord(record: GestureRecord): void {
    this.records = coalesceGestures([...this.records, record])
    this.updateChrome()
  }

  private renderBatch(): void {
    const panel = this.panel
    if (!panel) return
    const status = this.statusEl
    panel.replaceChildren()
    if (status) panel.append(status)
    if (!this.enabled) return
    const heading = document.createElement('div')
    heading.className = 'kbn-gesture-panel-heading'
    heading.textContent = this.records.length ? `${this.records.length} unsent gesture${this.records.length === 1 ? '' : 's'}` : 'No gestures yet'
    panel.append(heading)
    const list = document.createElement('div')
    list.className = 'kbn-gesture-list'
    const groups = new Map<string, { label: string; records: GestureRecord[] }>()
    for (const record of this.records) {
      const label = record.location.kind === 'slide'
        ? `slide ${record.location.slideIndex ?? '?'} · ${record.location.heading || 'untitled'}`
        : `page · ${record.location.title || 'untitled'}`
      const key = `${record.location.kind}|${record.location.slideIndex ?? ''}|${record.location.title}|${record.location.heading}`
      const group = groups.get(key) ?? { label, records: [] }
      group.records.push(record)
      groups.set(key, group)
    }
    for (const groupData of groups.values()) {
      const group = document.createElement('div')
      group.className = 'kbn-gesture-group'
      group.textContent = groupData.label
      list.append(group)
      for (const record of groupData.records) {
        const row = document.createElement('div')
        row.className = 'kbn-gesture-row'
        row.textContent = shortRecord(record)
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'kbn-gesture-delete'
        remove.textContent = '×'
        remove.title = 'Delete gesture'
        remove.addEventListener('click', (event) => {
          event.stopPropagation()
          this.records = this.records.filter((item) => item.id !== record.id)
          this.updateChrome()
        })
        row.append(remove)
        list.append(row)
      }
    }
    panel.append(list)
    if (!this.options.fiberId) {
      const warning = document.createElement('div')
      warning.className = 'kbn-gesture-warning'
      warning.textContent = 'No fiber id — gestures can be copied but not sent.'
      panel.append(warning)
    }
    if (this.fallbackText) this.addCopyButton(this.fallbackText)
  }

  private async send(): Promise<void> {
    if (!this.options.fiberId || this.records.length === 0 || this.sending) return
    const text = serializeGestures(this.options.filePath ?? this.sourceUrl, this.records)
    this.sending = true
    this.updateChrome()
    this.setStatus('Sending…')
    try {
      const response = await fetch(`${this.options.shuttleBase}/api/v1/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiber_id: this.options.fiberId, text, raise: true }),
      })
      if (response.status === 404) {
        this.fallbackText = text
        this.setStatus('no live worker for this fiber')
        this.addCopyButton(text)
      } else if (!response.ok) {
        this.setStatus(`Couldn’t send gestures (${response.status})`)
      } else {
        this.fallbackText = null
        this.records = []
        this.setStatus('Sent to the worker')
        showToast('Gesture batch sent')
      }
    } catch {
      this.fallbackText = text
      this.setStatus('Couldn’t reach the daemon')
      this.addCopyButton(text)
    } finally {
      this.sending = false
      this.updateChrome()
    }
  }

  private addCopyButton(text: string): void {
    const panel = this.panel
    if (!panel || panel.querySelector('.kbn-gesture-copy')) return
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'kbn-gesture-copy'
    button.textContent = 'copy to clipboard'
    button.addEventListener('click', () => {
      const pending = navigator.clipboard?.writeText(text)
      if (pending) {
        void pending.then(
          () => this.setStatus('Copied gesture batch'),
          () => this.setStatus('Clipboard unavailable — select the batch from the panel'),
        )
      } else {
        this.setStatus('Clipboard unavailable — select the batch from the panel')
      }
    })
    panel.append(button)
  }

  private setStatus(message: string): void {
    if (this.statusEl) this.statusEl.textContent = message
  }

  private startPolling(): void {
    this.stopPolling()
    void this.probe(true)
    this.pollTimer = window.setInterval(() => {
      if (!document.hidden && !this.pollBusy) void this.probe(false)
    }, POLL_MS)
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer)
    this.pollTimer = null
    this.pollBusy = false
  }

  private async probe(seed: boolean): Promise<void> {
    if (!this.frame.isConnected) {
      this.destroy()
      return
    }
    if (!this.enabled || !this.sourceUrl || this.pollBusy) return
    this.pollBusy = true
    try {
      const headers: Record<string, string> = {}
      if (this.validator) {
        const [etag, modified] = this.validator.split('|')
        if (etag) headers['If-None-Match'] = etag
        if (modified) headers['If-Modified-Since'] = modified
      }
      const response = await fetch(this.sourceUrl, { method: 'HEAD', cache: 'no-store', headers })
      if (response.status === 304) return
      if (!response.ok) {
        if (!seed && response.status === 404) this.reloadFrame()
        return
      }
      const signature = [
        response.headers.get('etag') ?? '',
        response.headers.get('last-modified') ?? '',
        response.headers.get('content-length') ?? '',
      ].join('|')
      if (!signature.replace(/\|/g, '') ) return
      if (!seed && this.validator && signature !== this.validator) this.reloadFrame()
      this.validator = signature
    } catch {
      // A tunnel hiccup is not evidence that the document changed.
    } finally {
      this.pollBusy = false
    }
  }

  private reloadFrame(): void {
    this.clearOverlay()
    this.validator = null
    this.frame.src = cacheBustUrl(this.sourceUrl)
  }

  private runtimeSpace(): RuntimeSpace | null {
    const doc = this.doc ?? this.frame.contentDocument
    const win = this.frame.contentWindow
    if (!doc || !win) return null
    try {
      const reveal = (win as unknown as { Reveal?: RevealApi }).Reveal
      const section = doc.querySelector<HTMLElement>('section.present') ?? doc.querySelector<HTMLElement>('.reveal .slides > section')
      const slides = doc.querySelector<HTMLElement>('.reveal .slides')
      if (section && (reveal || slides)) {
        const sectionRect = section.getBoundingClientRect()
        const config = reveal?.getConfig?.() ?? {}
        const logicalWidth = Number(config.width) || 1280
        const transformScale = scaleFromTransform(slides ? getComputedStyle(slides).transform : null)
        const scale = Number(reveal?.getScale?.()) || transformScale || sectionRect.width / logicalWidth || 1
        const indices = reveal?.getIndices?.()
        const h = indices?.h
        const v = indices?.v
        const slideIndex = h === undefined ? undefined : `${h + 1}${v && v > 0 ? `.${v + 1}` : ''}`
        const heading = this.pristineHeadings.get(section) ?? ''
        return {
          kind: 'slide',
          originX: sectionRect.left,
          originY: sectionRect.top,
          scale: scale > 0 ? scale : 1,
          slideIndex,
          heading,
          title: doc.title || this.options.filePath || 'document',
          root: section,
        }
      }
      return {
        kind: 'page',
        originX: 0,
        originY: 0,
        scale: 1,
        heading: '',
        title: doc.title || this.options.filePath || 'document',
        root: doc.documentElement,
      }
    } catch {
      return null
    }
  }

  private location(space: RuntimeSpace): GestureLocation {
    return {
      kind: space.kind,
      slideIndex: space.slideIndex,
      heading: space.heading,
      title: space.title,
    }
  }

  private scrollX(): number {
    return this.frame.contentWindow?.scrollX ?? 0
  }

  private scrollY(): number {
    return this.frame.contentWindow?.scrollY ?? 0
  }

  private elementTarget(target: EventTarget | null): HTMLElement | null {
    // The document belongs to the iframe's Window, so its HTMLElement/Text
    // constructors are not the outer board's constructors. Node types are the
    // realm-neutral test here.
    const node = target as Node | null
    if (!node) return null
    if (node.nodeType === 1) return node as HTMLElement
    if (node.nodeType === 3 && node.parentElement) return node.parentElement as HTMLElement
    return null
  }

  /** What is under the pointer, decided by `pickTarget` so the rule lives in
   * one tested place rather than in a pile of DOM conditions. */
  private hitTest(
    event: { clientX: number; clientY: number },
    space: RuntimeSpace,
  ): { outcome: HitOutcome; element: HTMLElement | null } {
    const doc = this.doc
    const chain = doc?.elementsFromPoint?.(event.clientX, event.clientY) ?? []
    const elements = [...chain].filter((node): node is HTMLElement =>
      node.nodeType === 1 && !(node as HTMLElement).closest('.kbn-gesture-overlay'))
    const outcome = pickTarget(
      elements.map((element) => this.candidate(element)),
      area(space.root.getBoundingClientRect()),
    )
    return { outcome, element: outcome.kind === 'element' ? elements[outcome.index] ?? null : null }
  }

  private candidate(element: HTMLElement): { area: number; structural: boolean; interactive: boolean } {
    return {
      area: area(element.getBoundingClientRect()),
      structural: this.isStructural(element),
      interactive: element.matches(INTERACTIVE_SELECTOR),
    }
  }

  private isStructural(element: HTMLElement): boolean {
    return element === this.doc?.documentElement || element === this.doc?.body || element.matches('.reveal,.slides')
  }

  private textTarget(element: HTMLElement): HTMLElement | null {
    if (element.matches('section,.reveal,.slides,img,video,canvas,svg,input,button,a')) return null
    const block = element.closest<HTMLElement>('p,h1,h2,h3,h4,h5,h6,li,figcaption,blockquote,td,th,caption')
    const candidate = block && this.doc?.documentElement.contains(block) ? block : element
    return this.isStructural(candidate) || !(candidate.textContent ?? '').trim() ? null : candidate
  }

  private captureOriginal(element: HTMLElement, space: RuntimeSpace): OriginalElement {
    const key = this.elementKey(element, space)
    const existing = this.originalElements.get(key)
    if (existing) return existing
    const original: OriginalElement = {
      box: roundBox(boxInSpace(element.getBoundingClientRect(), space, this.scrollX(), this.scrollY())),
      text: element.textContent ?? '',
      fingerprint: fingerprint(element),
    }
    this.originalElements.set(key, original)
    return original
  }

  private originalFor(element: HTMLElement, space: RuntimeSpace): OriginalElement {
    return this.originalElements.get(this.elementKey(element, space)) ?? this.captureOriginal(element, space)
  }

  private elementKey(element: HTMLElement, space: RuntimeSpace): string {
    const path: string[] = []
    let current: HTMLElement | null = element
    while (current && current !== space.root) {
      const parent: HTMLElement | null = current.parentElement
      if (!parent) break
      const index = Array.prototype.indexOf.call(parent.children, current)
      path.push(`${current.tagName.toLowerCase()}:${index}`)
      current = parent
    }
    return `${space.slideIndex ?? 'page'}|${path.reverse().join('/')}`
  }

  private id(): string {
    return `gesture-${this.nextId++}`
  }
}

function area(rect: { width: number; height: number }): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height)
}

function normalizedBox(x1: number, y1: number, x2: number, y2: number): GestureBox {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
}

function boxesIntersect(a: GestureBox, b: GestureBox): boolean {
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y
}

function boundingBox(targets: HTMLElement[], space: RuntimeSpace, scrollX: number, scrollY: number): GestureBox {
  const boxes = targets.map((target) => boxInSpace(target.getBoundingClientRect(), space, scrollX, scrollY))
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  return roundBox({ x: left, y: top, width: right - left, height: bottom - top })
}

function memberStyle(target: HTMLElement): MemberStyle {
  return { transform: target.style.transform }
}

function rectLike(rect: DOMRect): RectLike {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

/** Grow the group box from the dragged handle, keeping the opposite edge put. */
function resizedBox(before: GestureBox, direction: string, dx: number, dy: number): GestureBox {
  const west = direction.includes('w')
  const north = direction.includes('n')
  const east = direction.includes('e')
  const south = direction.includes('s')
  const width = Math.max(MIN_SIZE, before.width + (west ? -dx : east ? dx : 0))
  const height = Math.max(MIN_SIZE, before.height + (north ? -dy : south ? dy : 0))
  return {
    x: west ? before.x + before.width - width : before.x,
    y: north ? before.y + before.height - height : before.y,
    width,
    height,
  }
}

function roundPoint(point: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 }
}

function fingerprint(element: HTMLElement): string {
  const tag = element.tagName.toLowerCase()
  const id = element.id ? `#${element.id}` : ''
  const classes = [...element.classList].filter((name) => !name.startsWith('kbn-')).map((name) => `.${name}`).join('')
  const img = element.tagName.toLowerCase() === 'img'
    ? element as HTMLImageElement
    : element.querySelector<HTMLImageElement>('img')
  const source = img?.alt?.trim() || (img?.src ? img.src.split('/').pop()?.split(/[?#]/)[0] : '') || (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
  return `${tag}${id}${classes}${source ? ` (${source})` : ''}`
}

function shortRecord(record: GestureRecord): string {
  switch (record.kind) {
    case 'move': return `move ${record.fingerprint ?? 'element'}  ${miniBox(record.beforeBox)} → ${miniBox(record.afterBox)}`
    case 'resize': return `resize ${record.fingerprint ?? 'element'}  ${miniBox(record.beforeBox)} → ${miniBox(record.afterBox)}`
    case 'text': return `text ${record.fingerprint ?? 'element'}: “${preview(record.beforeText)}” → “${preview(record.afterText)}”`
    case 'comment': return `comment @ (${record.point?.x ?? '?'},${record.point?.y ?? '?'}): “${preview(record.commentText)}”`
    case 'group': return record.delta
      ? `move group [${(record.members ?? []).join(', ')}] by ${signedMini(record.delta.x)},${signedMini(record.delta.y)}`
      : `resize group [${(record.members ?? []).join(', ')}]  ${miniBox(record.beforeBox)} → ${miniBox(record.afterBox)}`
  }
}

function miniBox(box: GestureBox | undefined): string {
  if (!box) return '?,? ?x?'
  return `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`
}

function preview(value: string | undefined): string {
  const clean = (value ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > 36 ? `${clean.slice(0, 35)}…` : clean
}

function signedMini(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '?'
  const rounded = Math.round(value)
  return rounded >= 0 ? `+${rounded}` : String(rounded)
}
