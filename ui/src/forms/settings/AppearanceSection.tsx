import { useEffect, useState } from 'react'
import {
  APPEARANCE_CHANGED, DARK_THEMES, DARK_THEME_LABELS, appearance, saveAppearance, systemScheme, watchAppearance,
  type AppearanceMode, type DarkTheme,
} from '../../board/appearance'

const MODES: Array<{ id: AppearanceMode; label: string; note: (system: string) => string }> = [
  { id: 'light', label: 'Light', note: () => 'Pages read on light paper' },
  { id: 'dark', label: 'Dark', note: () => 'Pages read on your dark theme' },
  { id: 'system', label: 'Match system', note: system => `Follows this device, ${system} now` },
]
const DARK_NOTES: Record<DarkTheme, { note: string; paper: string; ornament: string }> = {
  'night-chart': { note: 'Parchment constellations on navy-black stock', paper: '#121b25', ornament: '#e0c081' },
  lamplight: { note: 'Candle-gilt stars on aubergine charcoal', paper: '#191419', ornament: '#ecbd76' },
}

export function AppearanceSection(): JSX.Element {
  const [choice, setChoice] = useState(appearance)
  const [system, setSystem] = useState(systemScheme)
  const [error, setError] = useState(false)
  useEffect(() => {
    watchAppearance()
    const refresh = (): void => { setChoice(appearance()); setSystem(systemScheme()) }
    const device = window.matchMedia?.('(prefers-color-scheme: dark)')
    window.addEventListener(APPEARANCE_CHANGED, refresh)
    device?.addEventListener('change', refresh)
    return () => { window.removeEventListener(APPEARANCE_CHANGED, refresh); device?.removeEventListener('change', refresh) }
  }, [])
  const choose = (next: typeof choice): void => {
    setError(!saveAppearance(next))
    setChoice(next)
  }
  return (
    <>
      <header className="set-pane-heading">
        <h2>Appearance</h2>
        <p>Constitutions keep their theme when it matches; otherwise they read as Portolan in light or your dark theme in dark. Reports follow; the board stays as it is.</p>
      </header>
      <fieldset className="set-opening-options">
        <legend className="set-section-label">Pages and reports</legend>
        {MODES.map(({ id, label, note }) => (
          <label key={id} className={`set-opening-choice${choice.mode === id ? ' set-opening-selected' : ''}`}>
            <input type="radio" name="appearance-mode" value={id} checked={choice.mode === id}
              onChange={() => choose({ ...choice, mode: id })} />
            <span><strong>{label}</strong><span className="set-opening-note">{note(system)}</span></span>
          </label>
        ))}
      </fieldset>
      <fieldset className="set-opening-options set-appearance-dark">
        <legend className="set-section-label">Dark theme</legend>
        {DARK_THEMES.map(id => (
          <label key={id} className={`set-opening-choice${choice.dark === id ? ' set-opening-selected' : ''}`}>
            <input type="radio" name="appearance-dark" value={id} checked={choice.dark === id}
              onChange={() => choose({ ...choice, dark: id })} />
            <span className="set-appearance-swatch" aria-hidden="true"
              style={{ background: DARK_NOTES[id].paper, color: DARK_NOTES[id].ornament }}>✦</span>
            <span><strong>{DARK_THEME_LABELS[id]}</strong><span className="set-opening-note">{DARK_NOTES[id].note}</span></span>
          </label>
        ))}
      </fieldset>
      {error && <div className="set-error" role="alert">This browser cannot save preferences, so this choice lasts until the page reloads.</div>}
      <p className="set-row-note">Saved in this browser only.</p>
    </>
  )
}
