import './phoneMeetingControls.css'
import { linkWords } from '../phone/phoneState'
import type { MeetingRecord } from './meeting'
import type { PhoneMeeting } from './phoneMeeting'

const views = new WeakMap<HTMLElement, ReturnType<typeof build>>()

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = className
  return el
}

function build(root: HTMLElement, phone: PhoneMeeting) {
  const controls = node('div', 'kbn-phone-controls')
  const words = node('div', 'kbn-phone-state')
  words.setAttribute('role', 'status')
  const caveat = node('p', 'kbn-phone-caveat')
  caveat.textContent = 'Loading models — speech isn’t captured until Listening.'
  const meter = node('div', 'kbn-phone-meter')
  meter.setAttribute('role', 'meter')
  meter.setAttribute('aria-label', 'Mic level')
  meter.setAttribute('aria-valuemin', '0')
  meter.setAttribute('aria-valuemax', '100')
  meter.append(node('div', 'kbn-phone-meter-fill'))
  const hint = node('p', 'kbn-phone-hint')
  const warning = node('div', 'kbn-phone-warning')
  warning.setAttribute('role', 'alert')
  const error = node('div', 'kbn-phone-error')
  error.setAttribute('role', 'alert')
  const connect = node('button', 'kbn-meeting-action kbn-phone-connect')
  connect.type = 'button'
  connect.textContent = 'Connect mic'
  const restore = node('button', 'kbn-meeting-action kbn-phone-restore')
  restore.type = 'button'
  restore.textContent = 'Restore mic'
  restore.addEventListener('click', () => { void phone.session.restore() })
  const reconnect = node('button', 'kbn-meeting-action kbn-phone-reconnect')
  reconnect.type = 'button'
  reconnect.textContent = 'Reconnect'
  reconnect.addEventListener('click', () => phone.session.returned())
  controls.append(words, caveat, meter, hint, warning, error, connect, restore, reconnect)
  root.insertBefore(controls, root.querySelector('.kbn-meeting-actions'))
  return { controls, words, caveat, meter, hint, warning, error, connect, restore, reconnect }
}

/** Phone audio controls belong only to a phone meeting, on either viewport. */
export function paintPhoneMeetingControls(root: HTMLElement, meeting: MeetingRecord, phone: PhoneMeeting): void {
  let view = views.get(root)
  if (!meeting.phone) {
    view?.controls.remove()
    views.delete(root)
    return
  }
  if (!view) { view = build(root, phone); views.set(root, view) }
  const session = phone.session
  const active = meeting.state !== 'failed' && meeting.state !== 'stopping'
  view.words.textContent = session.acquiring ? 'Opening mic…' : linkWords(session.link, session.linkReason, session.lostSince)
  view.caveat.hidden = meeting.state !== 'loading' || !['idle', 'opening'].includes(session.link)
  view.meter.hidden = !session.mic
  paintPhoneLevel(root, phone.peak)
  view.hint.hidden = !session.mic
  view.hint.textContent = 'Keep this screen on and the browser in front: locking or switching apps may cut the mic.' + (phone.lock.held ? ' Screen kept awake.' : '')
  view.warning.textContent = session.warning ?? ''
  view.warning.hidden = !session.warning
  view.error.textContent = session.error ?? ''
  view.error.hidden = !session.error
  view.connect.hidden = !active || session.mic !== null
  view.connect.disabled = session.acquiring || !meeting.launch?.trim()
  view.connect.onclick = () => { void phone.connect(meeting) }
  view.restore.hidden = !active || !session.needsRestore
  view.reconnect.hidden = !active || !session.mic || (session.link !== 'reconnecting' && session.lostSince === null)
}

export function paintPhoneLevel(root: HTMLElement, peak: number): void {
  const meter = root.querySelector<HTMLElement>('.kbn-phone-meter')
  if (!meter) return
  const percent = Math.round(Math.sqrt(Math.max(0, Math.min(1, peak))) * 100)
  meter.setAttribute('aria-valuenow', String(percent))
  meter.querySelector<HTMLElement>('.kbn-phone-meter-fill')!.style.width = `${percent}%`
  meter.classList.toggle('kbn-phone-meter-hot', peak > 0.9)
}
