import './gestures.css'

import { cacheBustUrl, showToast } from '../utils.js'
import {
  boxInSpace,
  pointInSpace,
  roundBox,
  scaleFromTransform,
  type CoordinateSpace,
  type GestureBox,
} from './coordinates.js'
import {
  coalesceGestures,
  serializeGestures,
  type GestureLocation,
  type GestureRecord,
} from './serializer.js'

const LONG_PRESS_MS = 300
const MOVE_TOLERANCE = 5
const TOGGLE_HOTKEY = 'g'
const BATCH_HOTKEY = ']'
export const WEBKIT_FORCE_AT_FORCE_MOUSE_DOWN = 1
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
.kbn-gesture-note { position: absolute; pointer-events: auto; transform: translate(-4px, -4px); }
.kbn-gesture-note-input, .kbn-gesture-textbox { position: absolute; }
.kbn-gesture-note::before { content: ''; display: block; width: 9px; height: 9px; border: 2px solid #9a4a35; border-radius: 50%; background: #fffdf6; box-shadow: 0 1px 4px rgba(27,22,17,.25); }
.kbn-gesture-note-input, .kbn-gesture-textbox { pointer-events: auto; width: 210px; box-sizing: border-box; margin: 6px 0 0 9px; padding: 5px 7px; border: 1px solid #9a7b35; border-radius: 3px; background: #fffdf6; color: #2e2a26; font: 14px/1.2 sans-serif; box-shadow: 0 2px 8px rgba(27,22,17,.18); }
.kbn-gesture-editing { outline: 2px solid rgba(194,150,59,.7); outline-offset: 2px; }
`

type RevealApi = {
  getConfig?: () => { width?: number; height?: number }
  getScale?: () => number
  getIndices?: () => { h?: number; v?: number }
}

type RuntimeSpace = CoordinateSpace & { root: HTMLElement; section: HTMLElement | null }
type WebKitForceEvent = MouseEvent & { webkitForce?: number }

export interface GestureLayerOptions {
  shuttleBase: string
  fiberId?: string
  filePath?: string
  originId?: string
  sourceUrl?: string
}

interface Selection {
  target: HTMLElement
  space: RuntimeSpace
  before: GestureBox
  boxEl: HTMLElement
  handles: HTMLElement[]
}

interface GroupSelection {
  targets: HTMLElement[]
  space: RuntimeSpace
  boxEl: HTMLElement
  handles: HTMLElement[]
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

interface NoteManipulation {
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
  pointerId: number
  x: number
  y: number
  space: RuntimeSpace
  transforms: Map<HTMLElement, string>
  fingerprints: string[]
  delta: { x: number; y: number }
}

interface Press {
  target: HTMLElement
  pointerId: number
  x: number
  y: number
  timer: number
  active: boolean
  space: RuntimeSpace
  group?: GroupSelection
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
  private toolButton: HTMLButtonElement | null = null
  private batchButton: HTMLButtonElement | null = null
  private sendButton: HTMLButtonElement | null = null
  private statusEl: HTMLElement | null = null
  private enabled = false
  private textTool = false
  private batchExpanded = false
  private records: GestureRecord[] = []
  private doc: Document | null = null
  private overlay: HTMLElement | null = null
  private selection: Selection | GroupSelection | null = null
  private press: Press | null = null
  private marquee: Marquee | null = null
  private noteManipulation: NoteManipulation | null = null
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
  private readonly onForce = (event: Event): void => this.force(event)
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
    this.disable()
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
    toggle.title = `G: toggle gestures on/off · ]: expand/collapse gesture batch`
    toggle.addEventListener('click', (event) => {
      event.stopPropagation()
      this.setEnabled(!this.enabled)
    })
    const tool = document.createElement('button')
    tool.type = 'button'
    tool.className = 'kbn-gesture-tool'
    tool.textContent = 'T'
    tool.title = 'Place a text box on the next click'
    tool.disabled = true
    tool.addEventListener('click', (event) => {
      event.stopPropagation()
      this.textTool = !this.textTool
      this.updateChrome()
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
    chrome.append(toggle, tool, batch, send)

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
    this.toolButton = tool
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
      doc.addEventListener('webkitmouseforcewillbegin', this.onForce, true)
      doc.addEventListener('webkitmouseforcechanged', this.onForce, true)
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
    doc.removeEventListener('webkitmouseforcewillbegin', this.onForce, true)
    doc.removeEventListener('webkitmouseforcechanged', this.onForce, true)
    this.doc = null
  }

  private setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.textTool = false
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

  private disable(): void {
    if (this.enabled) this.setEnabled(false)
    else this.stopPolling()
  }

  private updateChrome(): void {
    this.toggleButton?.setAttribute('aria-pressed', String(this.enabled))
    if (this.toggleButton) this.toggleButton.textContent = this.enabled ? 'gestures on' : 'gestures'
    if (this.toolButton) {
      this.toolButton.disabled = !this.enabled
      this.toolButton.classList.toggle('kbn-gesture-tool-active', this.textTool)
    }
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
    if (!target || this.textTool) return

    const handle = target.closest<HTMLElement>('[data-gesture-handle]')
    if (handle) {
      event.preventDefault()
      event.stopPropagation()
      if (this.selection && 'target' in this.selection) {
        const direction = handle.dataset.gestureHandle
        this.beginManipulation(this.selection.target, 'resize', direction, event)
      }
      // Group resize is deliberately not wired: the handles remain a clear
      // visual boundary, while moving a group is the useful operation.
      return
    }

    const note = target.closest<HTMLElement>('.kbn-gesture-note')
    if (note && !target.matches('input,textarea,button')) {
      const recordId = note.dataset.gestureId
      const record = this.records.find((item) => item.id === recordId && item.kind === 'note')
      const space = this.runtimeSpace()
      if (record?.point && space) {
        event.preventDefault()
        event.stopPropagation()
        this.beginNoteManipulation(note, record, space, event)
      }
      return
    }
    if (target.closest('.kbn-gesture-overlay')) return

    const space = this.runtimeSpace()
    if (!space) return
    if (this.isEmptySpace(target)) {
      this.beginMarquee(space, event)
      return
    }
    if (this.isStructural(target)) return

    this.clearPress()
    const group = this.groupContaining(target)
    const groupMember = group?.targets.find((member) => member === target || member.contains(target))
    const press: Press = {
      target: groupMember ?? target,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      space,
      group,
      active: false,
      timer: window.setTimeout(() => {
        if (this.press !== press || !this.enabled || press.active) return
        press.active = true
        event.preventDefault()
        event.stopPropagation()
        // Holding a member is the escape hatch from a marquee selection:
        // long-press always selects that member alone.
        this.select(press.target, space)
        this.beginManipulation(press.target, 'move', undefined, {
          pointerId: press.pointerId,
          clientX: press.x,
          clientY: press.y,
        })
      }, LONG_PRESS_MS),
    }
    this.press = press
  }

  private pointerMove(event: PointerEvent): void {
    if (this.marquee?.pointerId === event.pointerId) {
      this.updateMarquee(event)
      return
    }
    if (this.noteManipulation?.pointerId === event.pointerId) {
      event.preventDefault()
      event.stopPropagation()
      this.applyNoteManipulation(event)
      return
    }
    const press = this.press
    if (!press) {
      if (this.groupManipulation?.pointerId === event.pointerId) {
        event.preventDefault()
        event.stopPropagation()
        this.applyGroupManipulation(event)
      } else if (this.manipulation?.pointerId === event.pointerId) {
        event.preventDefault()
        event.stopPropagation()
        this.applyManipulation(event)
      }
      return
    }
    if (press.pointerId !== event.pointerId) return
    if (!press.active) {
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) >= MOVE_TOLERANCE) {
        this.clearPress()
        if (press.group) {
          event.preventDefault()
          event.stopPropagation()
          this.beginGroupManipulation(press.group, event)
          this.applyGroupManipulation(event)
        }
      }
      return
    }
    if (!this.manipulation) return
    event.preventDefault()
    event.stopPropagation()
    this.applyManipulation(event)
  }

  private pointerUp(event: PointerEvent): void {
    if (this.marquee?.pointerId === event.pointerId) {
      this.suppressClick = this.finishMarquee(event)
      return
    }
    if (this.noteManipulation?.pointerId === event.pointerId) {
      event.preventDefault()
      event.stopPropagation()
      this.finishNoteManipulation()
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
    if (this.press?.pointerId === event.pointerId) this.clearPress()
  }

  private pointerCancel(event: PointerEvent): void {
    if (this.marquee?.pointerId === event.pointerId) this.cancelMarquee()
    if (this.noteManipulation?.pointerId === event.pointerId) this.noteManipulation = null
    if (this.groupManipulation?.pointerId === event.pointerId) this.groupManipulation = null
    if (this.manipulation?.pointerId === event.pointerId) this.manipulation = null
    if (this.press?.pointerId === event.pointerId) this.clearPress()
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
    if (this.textTool) {
      event.preventDefault()
      event.stopPropagation()
      const space = this.runtimeSpace()
      if (space) this.placeTextBox(space, event.clientX, event.clientY)
      return
    }
    if (this.isEmptySpace(target)) this.deselect()
  }

  private doubleClick(event: MouseEvent): void {
    if (!this.enabled) return
    const target = this.elementTarget(event.target)
    if (!target || target.closest('.kbn-gesture-overlay')) return
    const textTarget = this.textTarget(target)
    if (textTarget) {
      event.preventDefault()
      event.stopPropagation()
      this.beginTextEdit(textTarget)
      return
    }
    if (this.isEmptySpace(target)) {
      event.preventDefault()
      event.stopPropagation()
      const space = this.runtimeSpace()
      if (space) this.placeNote(space, event.clientX, event.clientY)
    }
  }

  private force(event: Event): void {
    if (!this.enabled) return
    const force = (event as WebKitForceEvent).webkitForce
    if (typeof force !== 'number' || force < WEBKIT_FORCE_AT_FORCE_MOUSE_DOWN) return
    const target = this.elementTarget(event.target)
    if (!target || this.isEditableTarget(target) || target.closest('.kbn-gesture-overlay')) return
    if (this.textTool || this.isStructural(target) || this.isEmptySpace(target)) return
    const space = this.runtimeSpace()
    if (!space) return
    this.clearPress()
    this.select(target, space)
    event.preventDefault()
    event.stopPropagation()
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
    if (key === 't') {
      event.preventDefault()
      event.stopPropagation()
      this.textTool = !this.textTool
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
    this.textTool = false
    this.deselect()
    this.updateChrome()
  }

  private parentOwnsFocus(): boolean {
    const active = document.activeElement
    return active === this.frame || Boolean(this.host?.contains(active))
  }

  private isEditableTarget(target: EventTarget | null): boolean {
    const element = this.elementTarget(target)
    return Boolean(element?.matches('input,textarea,select,[contenteditable="true"],.kbn-gesture-note-input,.kbn-gesture-textbox') || element?.closest('input,textarea,select,[contenteditable="true"],.kbn-gesture-note-input,.kbn-gesture-textbox'))
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
      else this.deselect()
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
    return [...space.root.querySelectorAll<HTMLElement>('*')].filter((element) => {
      if (element.closest('.kbn-gesture-overlay') || this.isStructural(element)) return false
      if (element.matches('script,style,input,textarea,button,a')) return false
      if (!leafTags.has(element.tagName.toLowerCase()) && element.children.length > 0) return false
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })
  }

  private selectGroup(targets: HTMLElement[], space: RuntimeSpace): void {
    this.removeSelection()
    const boxEl = this.doc?.createElement('div')
    if (!boxEl) return
    boxEl.className = 'kbn-gesture-selection kbn-gesture-group-selection'
    const handles: HTMLElement[] = []
    for (const direction of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const handle = this.doc?.createElement('button')
      if (!handle) return
      handle.type = 'button'
      handle.className = `kbn-gesture-handle kbn-gesture-handle-${direction}`
      handle.dataset.gestureHandle = direction
      handle.setAttribute('aria-label', `Resize group ${direction} (not available)`)
      handle.disabled = true
      boxEl.append(handle)
      handles.push(handle)
    }
    this.ensureOverlay(space).append(boxEl)
    this.selection = { targets, space, boxEl, handles }
    this.renderSelection()
  }

  private groupContaining(target: HTMLElement): GroupSelection | undefined {
    if (!this.selection || !('targets' in this.selection)) return undefined
    return this.selection.targets.some((member) => member === target || member.contains(target))
      ? this.selection
      : undefined
  }

  private beginGroupManipulation(group: GroupSelection, event: { pointerId: number; clientX: number; clientY: number }): void {
    this.manipulation = null
    this.groupManipulation = {
      targets: group.targets,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      space: group.space,
      transforms: new Map(group.targets.map((target) => [target, target.style.transform])),
      fingerprints: group.targets.map((target) => this.captureOriginal(target, group.space).fingerprint),
      delta: { x: 0, y: 0 },
    }
  }

  private applyGroupManipulation(event: PointerEvent): void {
    const move = this.groupManipulation
    if (!move || move.pointerId !== event.pointerId) return
    const factor = move.space.kind === 'slide' ? move.space.scale : 1
    move.delta = {
      x: (event.clientX - move.x) / factor,
      y: (event.clientY - move.y) / factor,
    }
    for (const target of move.targets) {
      target.style.transform = [move.transforms.get(target), `translate(${move.delta.x}px, ${move.delta.y}px)`].filter(Boolean).join(' ')
    }
    this.renderSelection()
  }

  private finishGroupManipulation(): void {
    const move = this.groupManipulation
    this.groupManipulation = null
    if (!move || (Math.abs(move.delta.x) <= 2 && Math.abs(move.delta.y) <= 2)) return
    this.pushRecord({
      id: this.id(),
      kind: 'group',
      location: this.location(move.space),
      members: move.fingerprints,
      delta: move.delta,
    })
  }

  private beginNoteManipulation(marker: HTMLElement, record: GestureRecord, space: RuntimeSpace, event: PointerEvent): void {
    if (!record.point) return
    this.noteManipulation = {
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

  private applyNoteManipulation(event: PointerEvent): void {
    const move = this.noteManipulation
    if (!move || move.pointerId !== event.pointerId) return
    const factor = move.space.kind === 'slide' ? move.space.scale : 1
    move.point = roundPoint({
      x: move.before.x + (event.clientX - move.x) / factor,
      y: move.before.y + (event.clientY - move.y) / factor,
    })
    move.marker.style.left = `${move.point.x}px`
    move.marker.style.top = `${move.point.y}px`
  }

  private finishNoteManipulation(): void {
    const move = this.noteManipulation
    this.noteManipulation = null
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
    const before = roundBox(boxInSpace(target.getBoundingClientRect(), space, this.scrollX(), this.scrollY()))
    const boxEl = this.doc?.createElement('div')
    if (!boxEl) return
    boxEl.className = 'kbn-gesture-selection'
    const handles: HTMLElement[] = []
    for (const direction of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const handle = this.doc?.createElement('button')
      if (!handle) return
      handle.type = 'button'
      handle.className = `kbn-gesture-handle kbn-gesture-handle-${direction}`
      handle.dataset.gestureHandle = direction
      handle.setAttribute('aria-label', `Resize ${direction}`)
      boxEl.append(handle)
      handles.push(handle)
    }
    this.ensureOverlay(space)
    this.overlay?.append(boxEl)
    this.selection = { target, space, before, boxEl, handles }
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

  private deselect(): void {
    this.removeSelection()
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

  private placeNote(space: RuntimeSpace, clientX: number, clientY: number): void {
    const point = pointInSpace(clientX, clientY, space, this.scrollX(), this.scrollY())
    const overlay = this.ensureOverlay(space)
    const marker = this.doc?.createElement('div')
    if (!marker) return
    const id = this.id()
    marker.className = 'kbn-gesture-note'
    marker.dataset.gestureId = id
    marker.style.left = `${point.x}px`
    marker.style.top = `${point.y}px`
    const input = this.doc?.createElement('input')
    if (!input) return
    input.type = 'text'
    input.placeholder = 'Note…'
    input.className = 'kbn-gesture-note-input'
    marker.append(input)
    overlay.append(marker)
    this.finishInlineInput(input, () => {
      const text = input.value.trim()
      if (text) {
        this.pushRecord({
          id,
          kind: 'note',
          location: this.location(space),
          noteText: text,
          point: roundPoint(point),
          coalesceKey: id,
        })
      } else {
        marker.remove()
      }
    })
    input.focus()
  }

  private placeTextBox(space: RuntimeSpace, clientX: number, clientY: number): void {
    this.textTool = false
    const point = pointInSpace(clientX, clientY, space, this.scrollX(), this.scrollY())
    const overlay = this.ensureOverlay(space)
    const input = this.doc?.createElement('input')
    if (!input) return
    input.type = 'text'
    input.placeholder = 'Text…'
    input.className = 'kbn-gesture-textbox'
    input.style.left = `${point.x}px`
    input.style.top = `${point.y}px`
    overlay.append(input)
    this.finishInlineInput(input, () => {
      const text = input.value.trim()
      const afterBox = roundBox(boxInSpace(input.getBoundingClientRect(), space, this.scrollX(), this.scrollY()))
      input.remove()
      if (text) {
        this.pushRecord({
          id: this.id(),
          kind: 'new-text',
          location: this.location(space),
          afterText: text,
          afterBox,
        })
      }
      this.updateChrome()
    }, true)
    input.focus()
    this.updateChrome()
  }

  private finishInlineInput(input: HTMLInputElement, finish: () => void, enterCommits = false): void {
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
      } else if (event.key === 'Enter' && enterCommits) {
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
    this.clearPress()
    this.cancelMarquee()
    this.noteManipulation = null
    this.manipulation = null
    this.groupManipulation = null
    if (this.editing) {
      this.editing.finish()
      this.editing = null
    }
  }

  private clearPress(): void {
    if (this.press) window.clearTimeout(this.press.timer)
    this.press = null
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
          section,
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
        section: null,
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

  private isStructural(element: HTMLElement): boolean {
    return element === this.doc?.documentElement || element === this.doc?.body || element.matches('.reveal,.slides')
  }

  private isEmptySpace(element: HTMLElement): boolean {
    if (element === this.doc?.documentElement || element === this.doc?.body) return true
    if (element.matches('section,.reveal,.slides')) return true
    if (element.children.length === 0 && !(element.textContent ?? '').trim() && !element.matches('img,video,canvas,svg,input,button,a')) return true
    return false
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
    case 'note': return `note @ (${record.point?.x ?? '?'},${record.point?.y ?? '?'}): “${preview(record.noteText)}”`
    case 'new-text': return `new text box  ${miniBox(record.afterBox)}: “${preview(record.afterText)}”`
    case 'group': return `move group [${(record.members ?? []).join(', ')}] by ${signedMini(record.delta?.x)},${signedMini(record.delta?.y)}`
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
