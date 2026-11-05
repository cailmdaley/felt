import type { KanbanCard } from '../KanbanTypes.js'
import { isMobileViewport } from '../mobile.js'
import type { Voice } from '../voice.js'
import { anchorPopover } from './anchoredPopover.js'
import './voiceControl.css'

/** The chip and pending text change in place without rebuilding the composer. */
export function voiceControl(voice: Voice, card: KanbanCard, open: (id: string, origin: string) => void): { chip: HTMLElement; pending: HTMLElement; dismiss: () => boolean; dispose: () => void } {
  const chip = document.createElement('button')
  chip.type = 'button'
  chip.className = 'kbn-ctl-btn voice-chip'
  chip.setAttribute('aria-haspopup', 'menu')
  chip.setAttribute('aria-expanded', 'false')
  const pending = document.createElement('div')
  pending.className = 'voice-pending'
  pending.setAttribute('aria-live', 'polite')
  let menu: HTMLElement | null = null
  let release: (() => void) | null = null
  const close = (): void => {
    release?.(); release = null
    menu?.remove(); menu = null
    chip.setAttribute('aria-expanded', 'false')
    window.removeEventListener('pointerdown', outside, true)
  }
  const outside = (event: PointerEvent): void => { if (!menu?.contains(event.target as Node) && !chip.contains(event.target as Node)) close() }
  const matches = (id: string | undefined): boolean => !!id && (id === card.id || id === card.uid)
  const paint = (): void => {
    const state = voice.status
    chip.hidden = !state?.available
    if (!state?.available) { close(); pending.textContent = ''; return }
    const here = matches(state.target?.fiber_id) && (!state.target?.origin || state.target.origin === card.originId)
    const label = !state.enabled ? 'Off' : state.muted ? 'Muted' : state.state === 'yielded' ? 'Meeting' : state.state === 'failed' ? 'Failed' : state.state === 'starting' ? 'Starting' : here ? 'Here' : state.target?.name ?? 'No target'
    chip.textContent = `Voice · ${label}`
    chip.title = 'Voice controls'
    pending.textContent = matches(state.pending?.fiber_id) ? state.pending!.text : ''
    pending.title = pending.textContent
  }
  chip.addEventListener('click', () => {
    if (menu) { close(); return }
    const state = voice.status
    if (!state) return
    const target = state.target
    const elsewhere = target && (!matches(target.fiber_id) || (!!target.origin && target.origin !== card.originId))
    if (elsewhere && state.enabled && !state.muted && state.state === 'listening') {
      open(target.fiber_id, target.origin)
      return
    }
    menu = document.createElement('div')
    menu.className = 'ws-select-picker'
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', 'Voice controls')
    const item = (label: string, action: () => void): void => {
      const button = document.createElement('button')
      button.type = 'button'; button.className = 'ws-select-option'; button.textContent = label
      button.setAttribute('role', 'menuitem')
      button.addEventListener('click', () => { close(); action() })
      menu!.append(button)
    }
    if (state.target && (!matches(state.target.fiber_id) || (!!state.target.origin && state.target.origin !== card.originId))) item(`Open ${state.target.name}`, () => open(state.target!.fiber_id, state.target!.origin))
    if (!isMobileViewport()) {
      item(state.muted ? 'Unmute' : 'Mute', () => { void voice.set({ muted: !state.muted }).catch(showError) })
      item(state.enabled ? 'Turn voice off' : 'Turn voice on', () => { void voice.set({ enabled: !state.enabled }).catch(showError) })
    }
    if (state.state === 'failed' && state.error) note(state.error)
    if (state.last?.status === 'failed') note(`Delivery failed${state.last.detail ? `: ${state.last.detail}` : ''}`)
    function note(text: string): void { const el = document.createElement('div'); el.className = 'voice-error'; el.textContent = text; menu!.append(el) }
    function showError(error: unknown): void { chip.title = String(error) }
    ;(chip.closest('.kbn-ctl-composer') ?? chip.parentElement)?.append(menu)
    release = anchorPopover(menu, chip, { placement: 'above-start', matchWidth: true })
    chip.setAttribute('aria-expanded', 'true')
    menu.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); chip.focus() } })
    menu.querySelector<HTMLButtonElement>('button')?.focus()
    window.addEventListener('pointerdown', outside, true)
  })
  const unsubscribe = voice.subscribe(paint)
  paint()
  return { chip, pending, dismiss: () => { if (!menu) return false; close(); chip.focus(); return true }, dispose: () => { close(); unsubscribe() } }
}
