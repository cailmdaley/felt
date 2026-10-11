import type { KanbanCard } from './KanbanTypes.js'
import { civilWeekday, formatCivilDay, isoDayLocal, shiftCivilDay } from './civilDay.js'

/**
 * "Rest until": a centered dialog with a month grid and a vim-shaped cursor.
 * Everything is reachable without the pointer.
 *
 *   h l / j k      a day / a week earlier–later (a count prefix repeats: 3j)
 *   H L            a month earlier–later
 *   t · w · m      tomorrow · next Monday · a month from today
 *   Enter          rest until the cursor day
 *   n              rest with no return day
 *   Esc            cancel
 *
 * `submit` receives an ISO day, or '' for an undated rest. The earliest
 * choosable day is tomorrow: a day that has arrived would wake the card at once.
 */
export function restPopover(
  card: KanbanCard,
  anchor: HTMLElement,
  submit: (until: string) => Promise<void>,
): () => void {
  const previous = document.activeElement as HTMLElement | null
  const today = isoDayLocal(Date.now())
  const earliest = shiftCivilDay(today, 1)
  let cursor = earliest
  let count = ''

  const scrim = document.createElement('div')
  scrim.className = 'kbn-rest-scrim'
  const panel = document.createElement('div')
  panel.className = 'kbn-rest-popover'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', `Rest ${card.name}`)
  panel.tabIndex = -1

  const title = el('h2', 'kbn-rest-title', 'Rest until')
  const subject = el('p', 'kbn-rest-subject', card.name)
  const headline = el('p', 'kbn-rest-headline')
  headline.setAttribute('aria-live', 'polite')
  const relative = el('span', 'kbn-rest-relative')
  const monthLabel = el('div', 'kbn-rest-month')
  const grid = el('div', 'kbn-rest-grid')
  grid.setAttribute('role', 'grid')
  const presets = el('div', 'kbn-rest-presets')
  const countEl = el('span', 'kbn-rest-count')
  const keys = el(
    'p',
    'kbn-rest-keys',
    'h l day · j k week · H L month · t w m jump · enter rest · n undated · esc cancel',
  )

  const jumps: Array<{ key: string; label: string; day: () => string | undefined }> = [
    { key: 't', label: 'Tomorrow', day: () => earliest },
    { key: 'w', label: 'Next week', day: () => nextMonday(today) },
    { key: 'm', label: 'In a month', day: () => addMonths(today, 1) },
    { key: 'n', label: 'No date', day: () => undefined },
  ]
  for (const jump of jumps) {
    const chip = el('button', 'kbn-rest-chip')
    chip.type = 'button'
    chip.append(el('span', '', jump.label), el('kbd', '', jump.key))
    chip.addEventListener('click', () => {
      const day = jump.day()
      if (day === undefined) finish('')
      else { cursor = clamp(day); paint() }
    })
    presets.append(chip)
  }
  presets.append(countEl)

  const rest = el('button', 'kbn-rest-confirm', 'Rest')
  rest.type = 'button'
  rest.addEventListener('click', () => finish(cursor))

  panel.append(title, subject, headline, monthLabel, grid, presets, keys, rest)
  scrim.append(panel)
  // Keep the board's palette without inheriting an inert Desk or reader body.
  const root = anchor.closest('.kbn-modal') ?? document.body
  root.append(scrim)

  function clamp(day: string): string {
    return day < earliest ? earliest : day
  }

  function paint(): void {
    const long = formatCivilDay(cursor, { weekday: 'long', day: 'numeric', month: 'long' }) ?? cursor
    const days = daysBetween(today, cursor)
    headline.textContent = long
    relative.textContent = days === 1 ? 'tomorrow' : `in ${days} days`
    headline.append(' ', relative)
    monthLabel.textContent = formatCivilDay(cursor, { month: 'long', year: 'numeric' }) ?? ''
    countEl.textContent = count
    grid.replaceChildren(...weekdayHeads(), ...monthCells())
  }

  function weekdayHeads(): HTMLElement[] {
    return ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => el('span', 'kbn-rest-dow', d))
  }

  function monthCells(): HTMLElement[] {
    const first = `${cursor.slice(0, 8)}01`
    const lead = (civilWeekday(first)! + 6) % 7
    const cells: HTMLElement[] = []
    const start = shiftCivilDay(first, -lead)
    for (let i = 0; i < 42; i++) {
      const day = shiftCivilDay(start, i)
      if (i >= 35 && day.slice(0, 7) !== cursor.slice(0, 7)) break
      const cell = el('button', 'kbn-rest-day', String(Number(day.slice(8))))
      cell.type = 'button'
      cell.tabIndex = -1
      cell.setAttribute('role', 'gridcell')
      cell.setAttribute('aria-label', formatCivilDay(day, { weekday: 'long', day: 'numeric', month: 'long' }) ?? day)
      if (day.slice(0, 7) !== cursor.slice(0, 7)) cell.classList.add('kbn-rest-day-outside')
      if (day === today) cell.classList.add('kbn-rest-day-today')
      if (day < earliest) { cell.disabled = true; cell.classList.add('kbn-rest-day-past') }
      if (day === cursor) { cell.classList.add('kbn-rest-day-cursor'); cell.setAttribute('aria-selected', 'true') }
      cell.addEventListener('click', () => { cursor = day; paint() })
      cell.addEventListener('dblclick', () => finish(day))
      cells.push(cell)
    }
    return cells
  }

  function move(key: string): boolean {
    const n = count === '' ? 1 : Number(count)
    switch (key) {
      case 'h': case 'ArrowLeft': cursor = clamp(shiftCivilDay(cursor, -n)); break
      case 'l': case 'ArrowRight': cursor = shiftCivilDay(cursor, n); break
      case 'k': case 'ArrowUp': cursor = clamp(shiftCivilDay(cursor, -7 * n)); break
      case 'j': case 'ArrowDown': cursor = shiftCivilDay(cursor, 7 * n); break
      case 'H': cursor = clamp(addMonths(cursor, -n)); break
      case 'L': cursor = addMonths(cursor, n); break
      case 't': cursor = earliest; break
      case 'w': cursor = nextMonday(today); break
      case 'm': cursor = addMonths(today, 1); break
      case '0': case 'g': cursor = earliest; break
      default: return false
    }
    count = ''
    return true
  }

  function finish(until: string): void {
    close()
    void submit(until)
  }

  function onKey(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    // The dialog owns the keyboard while it is open.
    const own = (): void => { event.preventDefault(); event.stopImmediatePropagation() }
    if (event.key === 'Escape') { own(); close(); return }
    if (event.key === 'Enter') {
      const target = event.target as HTMLElement | null
      if (target instanceof HTMLButtonElement && target !== rest && !target.classList.contains('kbn-rest-day')) return
      own(); finish(cursor); return
    }
    if (event.key === 'n') { own(); finish(''); return }
    if (/^[1-9]$/.test(event.key) || (event.key === '0' && count !== '')) {
      own(); count += event.key; paint(); return
    }
    if (event.key === 'Backspace') { own(); count = count.slice(0, -1); paint(); return }
    if (event.key === 'Tab') {
      // Two stops: the dialog itself and the confirm button.
      own()
      ;(document.activeElement === rest ? panel : rest).focus({ preventScroll: true })
      return
    }
    if (move(event.key)) { own(); paint(); return }
    // Anything else is swallowed so board hotkeys cannot fire underneath.
    if (event.key.length === 1) own()
  }

  function onPointerDown(event: PointerEvent): void {
    if (!panel.contains(event.target as Node)) close()
  }

  function close(): void {
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKey, true)
    scrim.remove()
    if (previous?.isConnected) previous.focus({ preventScroll: true })
  }

  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKey, true)
  paint()
  panel.focus({ preventScroll: true })
  return close
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function nextMonday(day: string): string {
  const dow = civilWeekday(day) ?? 0
  return shiftCivilDay(day, ((8 - dow) % 7) || 7)
}

/** `months` calendar months from `day`, the day-of-month clamped to the target month's length. */
function addMonths(day: string, months: number): string {
  const total = Number(day.slice(0, 4)) * 12 + (Number(day.slice(5, 7)) - 1) + months
  const year = Math.floor(total / 12)
  const month = (total % 12 + 12) % 12
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const d = Math.min(Number(day.slice(8)), last)
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}
