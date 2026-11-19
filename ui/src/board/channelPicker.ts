import '@ui-sdk/web/dialog'
import { onScrimPress } from './dismissGesture.js'
import './channelPicker.css'

/** A channel a family can be moved to: how it is written in the rail, and how its constitutions spell it. */
export interface ChannelChoice { name: string; spelling: string }

/**
 * "Move to channel": a centered dialog naming what moves, a field, and the
 * channels it can go to, the field narrowing them. A press or Enter on a
 * channel moves it there; Enter on a name no channel has makes that channel,
 * spelled as typed; `#misc` takes its channel away. `submit` receives the
 * spelling to write, or null for misc. Esc or a press outside cancels.
 */
export function channelPicker(subject: string, current: string, choices: readonly ChannelChoice[], submit: (spelling: string | null) => void): () => void {
  const dialog = document.createElement('ui-dialog')
  const scrim = document.createElement('ui-dialog-content')
  scrim.setAttribute('aria-label', `Move ${subject} to a channel`)
  scrim.setAttribute('initial-focus', '.kbn-move-field')
  scrim.className = 'kbn-rest-scrim'
  const panel = el('div', 'kbn-move')
  const field = el('input', 'kbn-move-field')
  field.type = 'text'
  field.placeholder = 'A channel, or a new name'
  field.setAttribute('aria-label', 'Channel')
  const list = el('ul', 'kbn-move-list')
  list.setAttribute('role', 'listbox')
  panel.append(el('h2', 'kbn-move-title', 'Move to channel'), el('p', 'kbn-move-subject', subject), field, list)
  scrim.append(panel)
  dialog.append(scrim)
  document.body.append(dialog)

  // The rail writes every channel with a `#`, so a typed one means the same name.
  const bare = (name: string): string => name.trim().replace(/^#+\s*/, '')
  const key = (name: string): string => bare(name).toLowerCase().replace(/ /g, '-')
  const finish = (spelling: string | null): void => { close(); submit(spelling) }
  const option = (label: string, hint: string, pick: () => void, here = false): HTMLLIElement => {
    const item = el('li', '')
    const button = el('button', 'kbn-move-option')
    button.type = 'button'
    button.setAttribute('role', 'option')
    button.disabled = here
    button.append(el('span', 'kbn-move-name', label), el('span', 'kbn-move-hint', here ? 'here now' : hint))
    button.addEventListener('click', pick)
    item.append(button)
    return item
  }
  const paint = (): void => {
    const typed = bare(field.value), wanted = key(typed)
    const shown = choices.filter(choice => !wanted || choice.name.includes(wanted))
    const items = shown.map(choice => option(`#${choice.name}`, '', () => finish(choice.spelling), choice.name === current))
    if (typed && wanted !== 'misc' && !choices.some(choice => choice.name === wanted)) items.unshift(option(`#${wanted}`, 'new channel', () => finish(typed)))
    if (!wanted || 'misc'.includes(wanted)) items.push(option('#misc', 'no channel', () => finish(null), current === 'misc'))
    list.replaceChildren(...items)
  }
  field.addEventListener('input', paint)
  field.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    list.querySelector<HTMLButtonElement>('.kbn-move-option:not(:disabled)')?.click()
  })
  function close(): void { dialog.api.close() }
  onScrimPress(scrim, close)
  paint()
  void dialog.api.open().then(() => queueMicrotask(() => dialog.remove()))
  return close
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
