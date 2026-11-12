import type { KanbanCard } from '../KanbanTypes.js'
import type { Voice, VoiceUpdate } from '../voice.js'
import type { PhoneListening, PhoneListeningAttempt } from '../phoneListening.js'
import { isMobileViewport } from '../mobile.js'
import { TranscriptPanel } from '../voiceTranscript.js'
import { anchorPopover, type Release } from './anchoredPopover.js'
import { listenMode, type FiberSlug } from './voiceStrip.js'

export interface ListenOptions {
  /** The card a pin lands on: the band's highlighted thread, else its own. */
  card: () => KanbanCard
  voice: Voice
  phone?: PhoneListening
  shuttleBase: string
  fiberSlug: FiberSlug
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const ICONS = {
  mic: 'M8 1.5a2 2 0 0 0-2 2v4.25a2 2 0 0 0 4 0V3.5a2 2 0 0 0-2-2ZM3.5 7.75a4.5 4.5 0 0 0 9 0M8 12.25v2.25M5.5 14.5h5',
  slash: 'M2.5 1.5l11 13',
  menu: 'm5 6.75 3 3 3-3',
}
function svg(...paths: string[]): SVGSVGElement {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  icon.setAttribute('viewBox', '0 0 16 16')
  icon.setAttribute('width', '16'); icon.setAttribute('height', '16')
  icon.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    for (const [key, value] of Object.entries({ d, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) path.setAttribute(key, value)
    icon.append(path)
  }
  return icon
}
function iconButton(className: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'; button.className = `ws-header-icon ${className}`
  return button
}

/**
 * One mic toggle, with routing and the less frequent actions in ▾. The menu
 * names the current route (following, pinned to a card, or a meeting there)
 * and offers only the moves that change it.
 */
export class ListenControl {
  readonly el = document.createElement('span')
  private readonly button = iconButton('listen-mic')
  private readonly dropdown = iconButton('listen-dropdown')
  private readonly disposers: Array<() => void> = []
  private starting = false
  private menu: HTMLElement | null = null
  private menuState = ''
  private release: Release | null = null
  private localError: string | null = null
  private paintedIcon = ''
  private transcript: TranscriptPanel | null = null
  private readonly opts: ListenOptions

  constructor(opts: ListenOptions) {
    this.opts = opts
    this.el.className = 'listen-control'
    this.dropdown.append(svg(ICONS.menu))
    this.dropdown.setAttribute('aria-label', 'Listening options')
    this.dropdown.title = 'Listening options'
    this.dropdown.setAttribute('aria-haspopup', 'menu')
    this.dropdown.setAttribute('aria-expanded', 'false')
    this.dropdown.addEventListener('click', () => this.showMenu())
    this.button.addEventListener('click', () => { void this.press() })
    this.disposers.push(opts.voice.subscribe(() => this.paint()))
    if (opts.phone) this.disposers.push(opts.phone.subscribe(() => this.paint()))
    this.el.append(this.button, this.dropdown)
    this.paint()
  }

  dispose(): void {
    this.closeMenu()
    this.transcript?.dispose()
    this.disposers.forEach(dispose => dispose())
  }
  dismiss(): boolean {
    if (!this.menu) return false
    this.closeMenu(); this.dropdown.focus(); return true
  }
  private fail(error: unknown): void { this.localError = message(error); this.paint() }
  private failure(): string | null {
    const state = this.opts.voice.status
    const phone = state?.source === 'phone' ? this.opts.phone?.session : undefined
    return this.localError
      ?? (state?.state === 'failed' ? state.error ?? 'Listening failed' : null)
      ?? (state?.enabled && state.last?.status === 'failed' ? `Delivery failed${state.last.detail ? `: ${state.last.detail}` : ''}` : null)
      ?? phone?.error
      ?? (phone?.needsRestore ? phone.warning ?? 'Phone microphone interrupted' : null)
      ?? (phone && ['refused', 'ended', 'replaced'].includes(phone.link) ? phone.linkReason ?? 'Phone audio ended' : null)
      ?? (phone?.lostSince !== null && phone?.lostSince !== undefined ? phone.linkReason ?? 'Phone audio disconnected' : null)
      ?? null
  }

  /** Phone audio opens synchronously in the click, before any network request. */
  private async press(): Promise<void> {
    if (this.starting) return
    const { voice, phone } = this.opts
    const state = voice.status
    let opening: PhoneListeningAttempt | undefined
    this.starting = true; this.localError = null
    try {
      const start = !state?.enabled
      const unmute = start || !!state?.muted
      const usePhone = start ? isMobileViewport() : state?.source === 'phone'
      if (usePhone && isMobileViewport() && unmute) {
        if (!phone) throw new Error('Phone audio is unavailable on this board.')
        if (!phone.session.busy) opening = phone.begin()
        else if (phone.session.needsRestore) await phone.session.restore()
      }
      this.paint()
      const generation = opening ? await opening.ready : undefined
      await voice.set(start
        ? { enabled: true, muted: false, source: usePhone ? 'phone' : 'desktop' }
        : { muted: !state?.muted })
      if (opening && generation !== undefined) opening.bind(generation, voice.status!)
    } catch (error) { opening?.cancel(); this.fail(error) }
    finally { this.starting = false; this.paint() }
  }
  private change(values: VoiceUpdate): void {
    this.localError = null
    void this.opts.voice.set(values).catch(error => this.fail(error))
  }
  private stop(): void {
    this.localError = null
    void this.opts.voice.set({ enabled: false }).then(() => this.opts.phone?.cancel()).catch(error => this.fail(error))
  }

  private signature(): string {
    const state = this.opts.voice.status
    return JSON.stringify([state?.enabled, state?.muted, state?.follow, state?.system_audio, state?.target, state?.recorder, state?.source, this.failure()])
  }
  private paint(): void {
    const state = this.opts.voice.status
    const on = !!state?.enabled, muted = on && !!state?.muted, failure = this.failure()
    if (this.menu && this.signature() !== this.menuState) this.closeMenu()
    const drawn = muted ? 'muted' : 'mic'
    if (drawn !== this.paintedIcon) {
      this.button.replaceChildren(svg(ICONS.mic, ...(muted ? [ICONS.slash] : [])))
      this.paintedIcon = drawn
    }
    const mode = listenMode(state)
    const label = on ? muted ? 'Unmute' : 'Mute' : 'Listen'
    const title = on ? `${muted ? 'Muted. ' : ''}${this.route()}`
      : isMobileViewport() ? 'Listen with this phone’s mic' : 'Listen: words go to the card in view'
    this.button.disabled = this.starting || (!on && (isMobileViewport() ? !this.opts.phone : !state?.available || !state.sources.includes('desktop')))
    this.button.title = failure ? `${failure} — ${title}` : title
    this.button.setAttribute('aria-label', label)
    if (on) this.button.setAttribute('aria-pressed', String(muted))
    else this.button.removeAttribute('aria-pressed')
    this.el.dataset.mode = mode
    this.el.classList.toggle('listen-failed', !!failure)
    this.el.classList.toggle('listen-muted', muted)
    this.button.classList.toggle('listen-on', on)
  }

  /** Where words go now, in words. */
  private route(): string {
    const state = this.opts.voice.status, target = state?.target
    const name = target ? this.opts.fiberSlug(target.fiber_id, target.origin) ?? target.fiber_id.split('/').at(-1) : 'nothing yet'
    switch (listenMode(state)) {
      case 'meeting': return `Meeting on ${name}`
      case 'pinned': return `Pinned to ${name}`
      default: return `Following you: words go to ${name}`
    }
  }

  private closeMenu(): void {
    this.release?.(); this.release = null
    this.menu?.remove(); this.menu = null
    this.dropdown.setAttribute('aria-expanded', 'false')
    window.removeEventListener('pointerdown', this.outside, true)
  }
  private readonly outside = (event: PointerEvent): void => {
    if (!this.menu?.contains(event.target as Node) && !this.el.contains(event.target as Node)) this.closeMenu()
  }
  private item(label: string, act: () => void): void {
    const button = document.createElement('button')
    button.type = 'button'; button.className = 'ws-select-option'; button.textContent = label
    button.setAttribute('aria-label', label)
    button.setAttribute('role', 'menuitem')
    button.onclick = () => { this.closeMenu(); act() }
    this.menu!.append(button)
  }
  private showMenu(): void {
    if (this.menu) { this.closeMenu(); return }
    const { voice } = this.opts, card = this.opts.card()
    const state = voice.status
    const menu = this.menu = document.createElement('div')
    menu.className = 'ws-select-picker'
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Listening options')
    this.menuState = this.signature()
    const mode = listenMode(state)
    if (mode !== 'off') {
      const route = document.createElement('div')
      route.className = 'listen-route'; route.textContent = this.route()
      menu.append(route)
    }
    const target = state?.target
    const here = target?.origin === card.originId && [card.uid, card.id].includes(target?.fiber_id)
    const thisCard = { fiber_id: card.uid ?? card.id, origin: card.originId, name: card.name }
    const meetings = state?.source !== 'phone' && !isMobileViewport() && !!state?.sources.includes('desktop')
    if (mode === 'meeting') this.item('End meeting', () => this.change({ meeting: false }))
    if (mode === 'pinned') this.item('Follow me', () => this.change({ follow: true }))
    if (mode === 'following' || (mode === 'pinned' && !here)) this.item('Pin to this card', () => this.change({ follow: false, target: thisCard }))
    if (mode !== 'meeting' && meetings) this.item('Start meeting on this card', () => this.change({ meeting: true, target: thisCard }))
    const quiet = this.cadence(state?.follow ?? true)
    menu.append(quiet)
    this.item("Today's transcript", () => {
      this.transcript?.dispose()
      this.transcript = new TranscriptPanel(this.opts.shuttleBase, state?.recorder, card.uid ?? card.id, this.opts.fiberSlug, this.dropdown)
    })
    if (mode !== 'off') this.item('Stop listening', () => this.stop())
    const note = this.failure() ?? (state?.source === 'phone' ? this.opts.phone?.session.warning : null)
    if (note) { const error = document.createElement('div'); error.className = 'voice-error'; error.textContent = note; menu.append(error) }
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.dismiss() }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && event.target !== quiet.querySelector('input')) {
        event.preventDefault()
        const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const at = items.indexOf(document.activeElement as HTMLButtonElement)
        items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
      }
    })
    menu.addEventListener('focusout', event => { if (event.relatedTarget && !this.el.contains(event.relatedTarget as Node)) this.closeMenu() })
    this.el.append(menu)
    this.release = anchorPopover(menu, this.el, { placement: 'below-start' })
    this.dropdown.setAttribute('aria-expanded', 'true')
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    window.addEventListener('pointerdown', this.outside, true)
  }

  private cadence(following: boolean): HTMLElement {
    const el = document.createElement('label')
    el.className = 'listen-cadence'
    const label = `Quiet seconds (${following ? 'following' : 'pinned'})`
    el.textContent = label
    const quiet = document.createElement('input')
    quiet.type = 'number'; quiet.min = '0.001'; quiet.step = 'any'
    quiet.setAttribute('aria-label', label); el.append(quiet)
    const key = following ? 'quiet_seconds' : 'pinned_quiet_seconds'
    quiet.value = String(this.opts.voice.status?.[key] ?? (following ? 15 : 120))
    quiet.addEventListener('change', () => {
      const value = Number(quiet.value)
      if (!quiet.validity.valid || !Number.isFinite(value) || value <= 0) return
      quiet.disabled = true
      this.localError = null
      void this.opts.voice.set({ [key]: value })
        .catch(error => this.fail(error)).finally(() => { quiet.disabled = false })
    })
    return el
  }
}
