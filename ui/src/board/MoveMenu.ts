/**
 * The move menu — "Move to", then the places.
 *
 * Why this menu exists at all is written once, in `MoveDestinations.ts`. Here
 * it is only rendered: the legality comes from there, and each chosen item goes
 * back to the board's own wire calls through the `MoveBroker`.
 *
 * A ROW IS A PLACE NAME AND NOTHING ELSE. The heading says "Move to" and the
 * items say Drafts, In flight, Awaiting review, Resting — the same
 * words the board prints over those regions, with a rule between the Now
 * columns and the rest. Prose under a row was there to explain verbs, and the
 * places need no explaining; which card is being moved is carried by the
 * sheet's accessible name and the subline under the heading.
 *
 * It is raised by a LONG PRESS on the card itself — the gesture sits where
 * the object is. The menu mounts
 * on `document.body`, outside the card's scrolling column, so it is not clipped.
 */
import type { KanbanCard } from './KanbanTypes.js'
import type { MoveBroker } from './MoveDestinations.js'
import { isMobileViewport, onMobileChange } from './mobile.js'
import { clearSelection, dismissOnScrim, onPressRelease } from './dismissGesture.js'
import './MoveMenu.css'

/**
 * Put the desktop move popover next to its anchor — below by preference,
 * flipped above when the viewport's lower edge would clip it, and slid back
 * inside the right margin either way. `position: fixed` keeps it aligned to the
 * viewport while its anchor sits inside a scrolling card column.
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
    menu.append(buildMoveHeading('Move to', card.name))
    const list = document.createElement('div')
    list.className = 'kbn-move-list'
    let lastGroup: string | null = null
    for (const dest of broker.destinations(card)) {
      if (lastGroup !== null && dest.group !== lastGroup) {
        const rule = document.createElement('div')
        rule.className = 'kbn-move-rule'
        rule.setAttribute('role', 'separator')
        list.append(rule)
      }
      lastGroup = dest.group
      list.append(buildMoveItem(dest.label, () => {
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

  document.body.append(scrim, menu)
  anchor.setAttribute('aria-expanded', 'true')
  // The menu rises under a finger that is STILL DOWN (see `onPressRelease`), so
  // iPadOS may already have painted a selection where the menu now is. Clear it
  // here as well as in the tracker: the card's selection was killed before the
  // menu existed, and the run under the menu is a different one.
  clearSelection()
  renderRoot()
  if (!sheet) placeMoveMenu(menu, anchor)

  // UNTIL THE OPENING PRESS LETS GO, the menu takes no pointer input at all.
  // The long press fires at 450ms with the finger on the glass; without this,
  // the pointerup of that very gesture lands on whichever row rose under the
  // thumb and moves the card somewhere nobody chose. `pointer-events: none`
  // rather than ignoring pointerup, so the row cannot even light up.
  menu.style.pointerEvents = 'none'
  const stopPressWatch = onPressRelease(window, () => {
    menu.style.removeProperty('pointer-events')
    clearSelection()
  })

  dismissOnScrim(scrim, dismiss, window)
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
    stopPressWatch()
    window.removeEventListener('resize', onReflow)
    stopMobileWatch()
    anchor.setAttribute('aria-expanded', 'false')
    scrim.remove()
    menu.remove()
    onClosed?.()
  }

  return close
}

function buildMoveHeading(
  text: string,
  subline: string | null,
): HTMLElement {
  const row = document.createElement('div')
  row.className = 'kbn-move-heading'
  const label = document.createElement('span')
  label.className = 'kbn-move-heading-text'
  label.textContent = text
  row.append(label)
  if (subline) {
    const sub = document.createElement('span')
    sub.className = 'kbn-move-heading-sub'
    sub.textContent = subline
    row.append(sub)
  }
  return row
}

function buildMoveItem(label: string, onPick: () => void): HTMLElement {
  const item = document.createElement('button')
  item.type = 'button'
  item.className = 'kbn-move-item'
  item.setAttribute('role', 'menuitem')
  const main = document.createElement('span')
  main.className = 'kbn-move-item-label'
  main.textContent = label
  item.append(main)
  item.addEventListener('click', (e) => {
    e.stopPropagation()
    onPick()
  })
  return item
}
