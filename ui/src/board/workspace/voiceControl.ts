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
  let localError: string | null = null
  let scrollFrame = 0
  let release: (() => void) | null = null
  const close = (): void => {
    release?.(); release = null
    menu?.remove(); menu = null
    chip.setAttribute('aria-expanded', 'false')
    window.removeEventListener('pointerdown', outside, true)
  }
  const outside = (event: PointerEvent): void => { if (!menu?.contains(event.target as Node) && !chip.contains(event.target as Node)) close() }
  const matches = (id: string | undefined): boolean => !!id && (id === card.id || id === card.uid)
  const elsewhere = (target: NonNullable<Voice['status']>['target']): boolean =>
    !!target && (!matches(target.fiber_id) || (!!target.origin && target.origin !== card.originId))
  const hasMenu = (state: NonNullable<Voice['status']>): boolean => !isMobileViewport() || elsewhere(state.target) || !!localError || (state.state === 'failed' && !!state.error) || (state.last?.status === 'failed' || state.last?.status === 'unconfirmed')
  const paint = (): void => {
    const state = voice.status
    chip.hidden = !state?.available
    if (!state?.available) { close(); pending.textContent = ''; return }
    const here = !!state.target && !elsewhere(state.target)
    const label = localError ? 'Failed' : !state.enabled ? 'Off' : state.muted ? 'Muted' : state.state === 'yielded' ? 'Meeting' : state.state === 'failed' ? 'Failed' : state.state === 'starting' ? 'Starting' : here ? 'Here' : state.target?.name ?? 'No target'
    chip.textContent = `Voice · ${label}`
    chip.title = chip.textContent
    if (hasMenu(state)) { chip.setAttribute('aria-haspopup', 'menu'); chip.setAttribute('aria-expanded', menu ? 'true' : 'false') }
    else { close(); chip.removeAttribute('aria-haspopup'); chip.removeAttribute('aria-expanded') }
    const text = matches(state.pending?.fiber_id) ? state.pending!.text : ''
    if (pending.textContent !== text) {
      pending.textContent = text
      pending.scrollTop = pending.scrollHeight
      cancelAnimationFrame(scrollFrame)
      scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; pending.scrollTop = pending.scrollHeight })
    }
    pending.title = text
  }
  chip.addEventListener('click', () => {
    if (menu) { close(); return }
    const state = voice.status
    if (!state || !hasMenu(state)) return
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
    if (state.target && elsewhere(state.target)) item(`Open ${state.target.name}`, () => open(state.target!.fiber_id, state.target!.origin))
    if (!isMobileViewport()) {
      const set = (values: { muted?: boolean; enabled?: boolean }): void => {
        void voice.set(values).then(() => { localError = null; paint() }).catch(showError)
      }
      item(state.muted ? 'Unmute' : 'Mute', () => set({ muted: !state.muted }))
      item(state.enabled ? 'Turn voice off' : 'Turn voice on', () => set({ enabled: !state.enabled }))
    }
    if (localError) note(localError)
    if (state.state === 'failed' && state.error) note(state.error)
    if (state.last?.status === 'failed') note(`Delivery failed${state.last.detail ? `: ${state.last.detail}` : ''}`)
    if (state.last?.status === 'unconfirmed') note(`Delivery unconfirmed${state.last.detail ? `: ${state.last.detail}` : '; the message may have arrived. The transcript retains the words.'}`)
    function note(text: string): void { const el = document.createElement('div'); el.className = 'voice-error'; el.textContent = text; menu!.append(el) }
    function showError(error: unknown): void { localError = error instanceof Error ? error.message : String(error); paint() }
    ;(chip.closest('.kbn-ctl-composer') ?? chip.parentElement)?.append(menu)
    release = anchorPopover(menu, chip, { placement: 'above-start', matchWidth: true })
    chip.setAttribute('aria-expanded', 'true')
    menu.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); chip.focus() } })
    menu.querySelector<HTMLButtonElement>('button')?.focus()
    window.addEventListener('pointerdown', outside, true)
  })
  const unsubscribe = voice.subscribe(paint)
  paint()
  return { chip, pending, dismiss: () => { if (!menu) return false; close(); chip.focus(); return true }, dispose: () => { cancelAnimationFrame(scrollFrame); close(); unsubscribe() } }
}
