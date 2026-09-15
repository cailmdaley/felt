/**
 * The move menu — the drag, said in words.
 *
 * Why this menu exists at all is written once, in `MoveDestinations.ts`. Here
 * it is only rendered: the legality comes from there, and each chosen item goes
 * back to the board's own wire calls through the `MoveBroker`.
 *
 * It is raised by a LONG PRESS on the card itself, on the board, rather than by
 * a control inside the open sheet — the gesture sits where the object is, and a
 * button in the sheet's head row is a place nobody looked. The menu mounts on
 * `document.body`: the panel is a size container and would clip a descendant
 * popover, and the card's column scrolls.
 */
import type { KanbanCard } from './KanbanTypes.js'
import type { MoveBroker } from './MoveDestinations.js'
import { isMobileViewport, onMobileChange } from './mobile.js'

/**
 * Put the desktop move popover next to its anchor — below by preference,
 * flipped above when the viewport's lower edge would clip it, and slid back
 * inside the right margin either way. `position: fixed`, because the panel is
 * a size container and would clip a descendant popover.
 */
function placeMoveMenu(menu: HTMLElement, anchor: HTMLElement): void {
  const a = anchor.getBoundingClientRect()
  const m = menu.getBoundingClientRect()
  const gap = 6
  const below = a.bottom + gap
  const top = below + m.height > window.innerHeight - 8 ? Math.max(8, a.top - gap - m.height) : below
  const left = Math.max(8, Math.min(a.left, window.innerWidth - m.width - 8))
  menu.style.top = `${top}px`
  menu.style.left = `${left}px`
}

/**
 * Open the menu against `anchor` (the card, or any element to hang it off).
 * Returns the teardown — the caller holds it and is the only thing that closes
 * the menu deliberately; everything else (scrim, Escape, reflow) closes it from
 * the inside and then calls the caller's `onClosed`.
 *
 * The first pane is destinations. Choosing "Queue behind…" swaps the pane
 * rather than opening a second menu — one surface, two depths.
 */
export function openMoveMenu(
  card: KanbanCard,
  anchor: HTMLElement,
  broker: MoveBroker,
  onClosed?: () => void,
): () => void {
  const sheet = isMobileViewport()

  const scrim = document.createElement('div')
  scrim.className = 'kbn-move-scrim'
  const menu = document.createElement('div')
  menu.className = sheet ? 'kbn-move-menu kbn-move-sheet' : 'kbn-move-menu'
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', `Move ${card.name}`)

  const dismiss = (): void => close()

  const renderRoot = (): void => {
    menu.replaceChildren()
    menu.append(buildMoveHeading(card.name, null))
    const list = document.createElement('div')
    list.className = 'kbn-move-list'
    for (const dest of broker.destinations(card)) {
      list.append(buildMoveItem(dest.label, dest.hint, () => {
        if (dest.action.kind === 'queue') {
          renderQueue()
          return
        }
        dismiss()
        broker.perform(card, dest.action)
      }))
    }
    menu.append(list)
    // Focus the first item for the keyboard, but NOT on a touch sheet: the
    // focus ring there reads as a pre-selected choice sitting under the
    // thumb, which is the last impression a destructive-adjacent menu should
    // give when nobody has chosen anything yet.
    if (!sheet) menu.querySelector<HTMLElement>('.kbn-move-item')?.focus()
  }

  const renderQueue = (): void => {
    const targets = broker.queueTargets(card)
    menu.replaceChildren()
    menu.append(buildMoveHeading('Queue behind', renderRoot))
    if (targets.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'kbn-move-empty'
      // An empty list is a fact about the board, not a failure — say which.
      empty.textContent = 'Nothing on the board can take this one behind it.'
      menu.append(empty)
      return
    }
    // A search box only once the list is long enough that scanning it costs
    // more than typing. Below that it is chrome standing between the reader
    // and four names.
    const list = document.createElement('div')
    list.className = 'kbn-move-list'
    const draw = (filter: string): void => {
      const q = filter.trim().toLowerCase()
      list.replaceChildren()
      const shown = q
        ? targets.filter((t) => t.card.name.toLowerCase().includes(q) || t.card.id.toLowerCase().includes(q))
        : targets
      for (const t of shown) {
        // The hint names the TAIL when it differs from the card you picked:
        // joining a queue means joining its end, and the menu should not let
        // that happen behind your back.
        const hint = t.tail === t.card.id ? undefined : `joins the end of its queue`
        list.append(buildMoveItem(t.card.name, hint, () => {
          dismiss()
          broker.queueBehind(card, t.tail)
        }))
      }
      if (shown.length === 0) {
        const none = document.createElement('p')
        none.className = 'kbn-move-empty'
        none.textContent = 'No match.'
        list.append(none)
      }
    }
    if (targets.length > 7) {
      const search = document.createElement('input')
      search.type = 'search'
      search.className = 'kbn-move-search'
      search.placeholder = 'Find a card…'
      search.setAttribute('aria-label', 'Filter queue targets')
      search.addEventListener('input', () => draw(search.value))
      menu.append(search)
    }
    draw('')
    menu.append(list)
    if (!sheet) menu.querySelector<HTMLElement>('.kbn-move-search, .kbn-move-item')?.focus()
  }

  document.body.append(scrim, menu)
  anchor.setAttribute('aria-expanded', 'true')
  renderRoot()
  if (!sheet) placeMoveMenu(menu, anchor)

  scrim.addEventListener('pointerdown', (e) => {
    e.stopPropagation()
    dismiss()
  })
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    dismiss()
  }
  document.addEventListener('keydown', onKey, true)

  // A MENU IS TRANSIENT, so any reflow under it takes it down rather than
  // being chased. The desktop popover is placed once against the button's
  // rectangle, and a resize moves that rectangle out from under it; crossing
  // 700px is worse still, since the menu would have to change shape as well
  // as place. Re-placing on every frame would be work spent on a surface the
  // reader is about to dismiss anyway — one tap re-opens it, correct.
  const onReflow = (): void => dismiss()
  window.addEventListener('resize', onReflow)
  const stopMobileWatch = onMobileChange(onReflow)

  let closed = false
  function close(): void {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('resize', onReflow)
    stopMobileWatch()
    anchor.setAttribute('aria-expanded', 'false')
    scrim.remove()
    menu.remove()
    onClosed?.()
  }

  return close
}

function buildMoveHeading(text: string, onBack: (() => void) | null): HTMLElement {
  const row = document.createElement('div')
  row.className = 'kbn-move-heading'
  if (onBack) {
    const back = document.createElement('button')
    back.type = 'button'
    back.className = 'kbn-move-back'
    back.setAttribute('aria-label', 'Back to destinations')
    back.textContent = '‹'
    back.addEventListener('click', (e) => {
      e.stopPropagation()
      onBack()
    })
    row.append(back)
  }
  const label = document.createElement('span')
  label.className = 'kbn-move-heading-text'
  label.textContent = text
  row.append(label)
  return row
}

function buildMoveItem(label: string, hint: string | undefined, onPick: () => void): HTMLElement {
  const item = document.createElement('button')
  item.type = 'button'
  item.className = 'kbn-move-item'
  item.setAttribute('role', 'menuitem')
  const main = document.createElement('span')
  main.className = 'kbn-move-item-label'
  main.textContent = label
  item.append(main)
  if (hint) {
    const sub = document.createElement('span')
    sub.className = 'kbn-move-item-hint'
    sub.textContent = hint
    item.append(sub)
  }
  item.addEventListener('click', (e) => {
    e.stopPropagation()
    onPick()
  })
  return item
}
