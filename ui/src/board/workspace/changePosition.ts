export interface ChangeReadingState {
  expanded: string[]
  whole: string[]
  anchor?: { window: string; row: number; offset: number }
}

export function windowRows(host: HTMLElement): HTMLElement[] {
  if (!host.matches('.change-diff-window')) return [host]
  const root = host.dataset.renderState === 'highlighted'
    ? host.querySelector('diffs-container')?.shadowRoot
    : host
  return [...(root?.querySelectorAll<HTMLElement>(
    host.dataset.renderState === 'highlighted'
      ? '[data-line]'
      : '.change-plain-row:not([data-line-type="metadata"])',
  ) ?? [])]
}

export function readingAnchor(scroll: HTMLElement, windows: Iterable<HTMLElement>): ChangeReadingState['anchor'] {
  const bounds = scroll.getBoundingClientRect()
  const scale = scroll.clientHeight / bounds.height
  for (const host of windows) {
    const box = host.getBoundingClientRect()
    if (box.bottom <= bounds.top || box.top >= bounds.bottom) continue
    const rows = windowRows(host)
    const row = rows.findIndex(row => row.getBoundingClientRect().bottom > bounds.top)
    if (row >= 0) return {
      window: host.dataset.windowId!, row,
      offset: (rows[row].getBoundingClientRect().top - bounds.top) * scale,
    }
  }
}
