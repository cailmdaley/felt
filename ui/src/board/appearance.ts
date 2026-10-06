/**
 * Appearance belongs to this browser. It resolves to a light or dark scheme
 * that constitution pages and embedded documents follow; the board chrome
 * keeps its own paper.
 */
export type AppearanceMode = 'light' | 'dark' | 'system'
export type Scheme = 'light' | 'dark'
export const DARK_THEMES = ['night-chart', 'lamplight'] as const
export type DarkTheme = typeof DARK_THEMES[number]
export const DARK_THEME_LABELS: Record<DarkTheme, string> = { 'night-chart': 'Night chart', lamplight: 'Lamplight' }
/** The light page a dark theme gives way to. */
export const LIGHT_THEME = 'portolan'
export interface Appearance { mode: AppearanceMode; dark: DarkTheme }
export const APPEARANCE_KEY = 'shuttle.appearance'
export const APPEARANCE_CHANGED = 'shuttle-appearance-changed'
const DEFAULT: Appearance = { mode: 'system', dark: 'night-chart' }
const SYSTEM_DARK = '(prefers-color-scheme: dark)'

function parse(raw: string | null | undefined): Appearance {
  try {
    const value: unknown = JSON.parse(raw ?? 'null')
    if (!value || typeof value !== 'object') return DEFAULT
    const { mode, dark } = value as Partial<Record<keyof Appearance, unknown>>
    return {
      mode: mode === 'light' || mode === 'dark' || mode === 'system' ? mode : DEFAULT.mode,
      dark: DARK_THEMES.includes(dark as DarkTheme) ? dark as DarkTheme : DEFAULT.dark,
    }
  } catch { return DEFAULT }
}
function stored(): Appearance {
  try { return parse(globalThis.localStorage?.getItem(APPEARANCE_KEY)) } catch { return DEFAULT }
}

/** The session holds the choice even when site storage cannot. */
let current: Appearance | undefined
export function appearance(): Appearance { return current ??= stored() }

/** Applies the choice for this page; returns false when this browser cannot retain it. */
export function saveAppearance(next: Appearance): boolean {
  current = { ...next }
  let saved = true
  try { globalThis.localStorage.setItem(APPEARANCE_KEY, JSON.stringify(current)) } catch { saved = false }
  announce()
  return saved
}

export function themeScheme(theme: string): Scheme {
  return DARK_THEMES.includes(theme as DarkTheme) ? 'dark' : 'light'
}
export function systemScheme(): Scheme {
  try { return globalThis.matchMedia?.(SYSTEM_DARK).matches ? 'dark' : 'light' } catch { return 'light' }
}
export function resolveScheme(mode: AppearanceMode, system: Scheme = systemScheme()): Scheme {
  return mode === 'system' ? system : mode
}
export function currentScheme(): Scheme { return resolveScheme(appearance().mode) }

/** A theme of the resolved scheme stays; any other gives way to that scheme's page. */
export function appearanceTheme(declared: string, scheme: Scheme, dark: DarkTheme): string {
  if (themeScheme(declared) === scheme) return declared
  return scheme === 'dark' ? dark : LIGHT_THEME
}

let last = ''
function announce(): void {
  const scheme = currentScheme(), state = `${scheme}:${appearance().dark}`
  if (typeof document !== 'undefined') document.documentElement.dataset.wsAppearance = scheme
  if (state === last) return
  last = state
  globalThis.dispatchEvent?.(new Event(APPEARANCE_CHANGED))
}

let watching = false
/** Mirror the resolved scheme onto the root and announce each change: a choice here, in another tab, or in the system. */
export function watchAppearance(): void {
  if (watching || typeof window === 'undefined') return
  watching = true
  last = `${currentScheme()}:${appearance().dark}`
  document.documentElement.dataset.wsAppearance = currentScheme()
  try { window.matchMedia?.(SYSTEM_DARK).addEventListener('change', announce) } catch { /* No media queries, no system scheme. */ }
  window.addEventListener('storage', event => {
    if (event.key !== APPEARANCE_KEY && event.key !== null) return
    current = stored()
    announce()
  })
}
