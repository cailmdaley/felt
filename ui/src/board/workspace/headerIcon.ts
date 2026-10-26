const shapes = {
  constitution: '<rect x="3" y="1.5" width="10" height="13" rx="1"/><path d="M5.5 5h5M5.5 8h5M5.5 11h3"/>',
  console: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="m4 6 2.5 2L4 10m4.5 0h3"/>',
  settings: '<path d="M6.6 1.5h2.8l.5 2 1.1.6 2-.6 1.4 2.4-1.5 1.4v1.4l1.5 1.4-1.4 2.4-2-.6-1.1.6-.5 2H6.6l-.5-2-1.1-.6-2 .6-1.4-2.4 1.5-1.4V7.3L1.6 5.9 3 3.5l2 .6 1.1-.6Z"/><circle cx="8" cy="8" r="2.25"/>',
  close: '<path d="m3 8 3 3 7-7"/>',
  rest: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
  temper: '<path d="M8 1.5 14.5 8 8 14.5 1.5 8Z"/>',
  discard: '<path d="M2.5 4.5h11M6.5 4.5v-2h3v2M4 4.5l.75 9.5h6.5L12 4.5M6.75 7v4.5M9.25 7v4.5"/>',
  leave: '<path d="m4 4 8 8m0-8-8 8"/>',
} as const

export type HeaderIcon = keyof typeof shapes

/** The header's stroke icons share the workspace's 16-pixel SVG grid. */
export function headerIcon(name: HeaderIcon): string {
  return `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${shapes[name]}</svg>`
}
