/**
 * CaptureForm — chat-first "new idea" capture for the kanban.
 *
 * The `✶` button in the kanban header opens this dialog. The user speaks/types
 * a free-form yap, picks a project and optionally an agent, and Submit POSTs to
 * the Shuttle daemon's `POST /api/v1/capture`. The daemon spawns a *background*
 * session that crystallizes the yap into a fiber and claims itself — the card
 * shows up on the board organically later; there is no optimistic placeholder.
 *
 * Contrast with StashForm: stash files the fiber directly (title, slug, shuttle
 * block — you do the structuring); capture hands raw thought to a session that
 * does the structuring for you.
 *
 * Standalone-UI note: `shuttleBase` defaults to `''` (relative), so the form
 * talks to its own daemon same-origin (dev: through the Vite proxy). Capture is
 * owner-routed at the daemon — `origin` forwards to the owning host — so the
 * project picker may offer remote projects, unlike Stash's local-only create.
 *
 * Built on AppDialog (Radix) — focus trap, Esc, portal, scroll lock for free.
 * Cmd/Ctrl+Enter submits.
 */

import { useEffect, useRef, useState } from 'react'
import { AppDialog } from './AppDialog'
import type { AgentEntry } from './StashForm'
import { shuttleOrigin } from './projectModel'

/**
 * Fallback when the registry fetch fails — keeps the dialog usable offline.
 * The live list comes from /api/v1/agents (constraint metadata included), so
 * effort/chrome stay disabled on the fallback (no metadata to gate them).
 */
const FALLBACK_AGENTS: AgentEntry[] = [
  { id: 'claude-opus', default: true },
  { id: 'claude-sonnet', default: false },
  { id: 'claude-fable', default: false },
  { id: 'codex', default: false },
]

// Capture's default worker: claude-opus at xhigh reasoning. A captured yap is
// often a real piece of thinking to crystallize, not throwaway — worth the
// strong model. opus's registry default_effort is now xhigh too, so the live
// agents list yields the same; this seed just keeps the dialog correct before
// the registry loads (offline fallback). Switching the agent re-derives effort
// from that agent's own default_effort.
const CAPTURE_DEFAULT_AGENT = 'claude-opus'
const CAPTURE_DEFAULT_EFFORT = 'xhigh'

export interface CaptureFormProps {
  /** Default destination: a project path (matched against `availableCities` by
   *  path). Null = fall through to activity ranking. */
  cityPath?: string | null
  /** All connected projects; each carries its own originId + path. */
  availableCities?: Array<{
    id: string
    name?: string
    path: string
    originId: string
  }>
  /** Unix-ms of most recent activity per project id — recency ranking for the
   *  default selection and picker order. */
  cityActivityById?: Record<string, number>
  /** Called after a successful spawn with the daemon's tmux session name. */
  onSpawned: (tmuxSession: string) => void
  /** Called on cancel / Esc / overlay click. */
  onCancel: () => void
  /** Shuttle daemon base. Defaults to `''` (relative / same-origin). */
  shuttleBase?: string
}

interface CaptureResponse {
  spawned?: boolean
  tmux_session?: string
  agent?: string
  reason?: string
  error?: string
}

export function CaptureForm({
  cityPath,
  availableCities = [],
  cityActivityById = {},
  onSpawned,
  onCancel,
  shuttleBase = '',
}: CaptureFormProps): JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [agent, setAgent] = useState<string>(CAPTURE_DEFAULT_AGENT)
  const [agents, setAgents] = useState<AgentEntry[]>(FALLBACK_AGENTS)
  // Axes come from the selected agent's registry constraint metadata — no
  // hardcoded lists. The effective effort is always a concrete token when
  // the selected agent supports reasoning levels. Seeded to the capture default
  // (xhigh) for the initial opus selection; `handleAgentChange` re-derives from
  // the chosen agent's own default_effort thereafter.
  const [effort, setEffort] = useState<string>(CAPTURE_DEFAULT_EFFORT)
  const [chrome, setChrome] = useState<boolean>(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Same default-selection priority as StashForm: scoped project by path →
  // most-recently-active → alphabetical → null (picker hidden).
  const sortedCities = [...availableCities].sort((a, b) => {
    const recencyDelta = (cityActivityById[b.id] ?? 0) - (cityActivityById[a.id] ?? 0)
    if (recencyDelta !== 0) return recencyDelta
    return (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, { sensitivity: 'base' })
  })
  const [selectedCityId, setSelectedCityId] = useState<string | null>(() => {
    if (cityPath) {
      const match = availableCities.find((c) => c.path === cityPath)
      if (match) return match.id
    }
    return sortedCities[0]?.id ?? null
  })

  // Autofocus the yap — it's the whole point of the dialog.
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  // Agent registry (base agents only; aliases resolve to base + axes). The
  // fallback list stays in place when the daemon is unreachable.
  useEffect(() => {
    let cancelled = false
    fetch(`${shuttleBase}/api/v1/agents`)
      .then((res) => (res.ok ? res.json() : null))
      .then((raw: AgentEntry[] | { agents?: AgentEntry[] } | null) => {
        if (cancelled || !raw) return
        const list = (Array.isArray(raw) ? raw : raw.agents ?? []).filter((a) => !a.alias_of)
        if (list.length) setAgents(list)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [shuttleBase])

  const agentRec = agents.find((a) => a.id === agent)
  const effortLevels = agentRec?.effort_levels ?? []
  const effectiveEffort = effortLevels.includes(effort)
    ? effort
    : agentRec?.default_effort && effortLevels.includes(agentRec.default_effort)
      ? agentRec.default_effort
      : ''
  const chromeCapable = agentRec?.chrome_capable ?? false

  const handleAgentChange = (id: string): void => {
    setAgent(id)
    const rec = agents.find((a) => a.id === id)
    const levels = rec?.effort_levels ?? []
    setEffort(rec?.default_effort && levels.includes(rec.default_effort) ? rec.default_effort : '')
    if (!(rec?.chrome_capable ?? false)) setChrome(false)
  }

  const selectedCity = availableCities.find((c) => c.id === selectedCityId) ?? null

  const submit = async (): Promise<void> => {
    if (submitting) return
    const trimmed = prompt.trim()
    if (!trimmed) {
      setError('Say something first — the session needs a yap to work with.')
      textareaRef.current?.focus()
      return
    }
    if (!selectedCity) {
      setError('Pick a project — the capture session needs a directory to land in.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`${shuttleBase}/api/v1/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: trimmed,
          project_dir: selectedCity.path,
          origin: shuttleOrigin(selectedCity.originId),
          agent,
          ...(effectiveEffort ? { effort: effectiveEffort } : {}),
          ...(chrome ? { chrome: true } : {}),
        }),
      })
      const data = (await res.json().catch(() => ({}))) as CaptureResponse
      if (!res.ok || !data.spawned) {
        const msg =
          data.reason === 'project_dir_missing'
            ? `Project directory not found on the daemon: ${selectedCity.path}`
            : data.reason ?? data.error ?? `Capture failed (${res.status})`
        throw new Error(msg)
      }
      onSpawned(data.tmux_session ?? '')
    } catch (err) {
      const msg = (err as { message?: string })?.message ?? String(err)
      setError(msg.includes('fetch') ? 'Couldn’t reach the Shuttle daemon (:4000).' : msg)
      setSubmitting(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <AppDialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
      title="New idea"
      description="Speak it — a background session crystallizes the yap into a card."
    >
      <div className="capture-form" onKeyDown={handleKeyDown}>
        <textarea
          ref={textareaRef}
          className="capture-yap"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Speak the idea — a session will write the card"
          rows={6}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            resize: 'vertical',
            minHeight: '7rem',
            fontFamily: "var(--font-main, 'EB Garamond', serif)",
            fontSize: '15px',
            lineHeight: 1.45,
            color: '#2E2A26',
            background: '#FFFFFF',
            border: '1px solid rgba(46, 42, 38, 0.20)',
            borderRadius: '3px',
            padding: '8px 10px',
          }}
        />
        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
          {availableCities.length > 0 && (
            <label style={{ flex: '2 1 12rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
              <span className="capture-label" style={labelStyle}>Project</span>
              <select
                className="capture-city"
                value={selectedCityId ?? ''}
                onChange={(e) => setSelectedCityId(e.target.value || null)}
                style={selectStyle}
              >
                {sortedCities.map((c) => (
                  <option key={`${c.originId}:${c.id}`} value={c.id}>
                    {(c.name ?? c.id) + (c.originId === 'local' ? '' : ` · ${shuttleOrigin(c.originId)}`)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label style={{ flex: '1 1 8rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
            <span className="capture-label" style={labelStyle}>Agent</span>
            <select
              className="capture-agent"
              value={agent}
              onChange={(e) => handleAgentChange(e.target.value)}
              style={selectStyle}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id}{a.id === CAPTURE_DEFAULT_AGENT ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: '1 1 6rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
            <span className="capture-label" style={labelStyle}>Effort</span>
            <select
              className="capture-effort"
              value={effectiveEffort}
              onChange={(e) => setEffort(e.target.value)}
              disabled={effortLevels.length === 0}
              style={{ ...selectStyle, opacity: effortLevels.length === 0 ? 0.5 : 1 }}
            >
              {effortLevels.map((lvl) => (
                <option key={lvl} value={lvl}>
                  {lvl}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label
          className="capture-chrome"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.5rem',
            fontSize: '13px',
            color: '#2E2A26',
            cursor: chromeCapable ? 'pointer' : 'not-allowed',
            opacity: chromeCapable ? 1 : 0.45,
            userSelect: 'none',
          }}
        >
          <input
            type="checkbox"
            checked={chrome}
            disabled={!chromeCapable}
            onChange={(e) => setChrome(e.target.checked)}
            style={{ accentColor: '#3D5BA0', margin: 0 }}
          />
          <code style={{ fontSize: '12px' }}>--chrome</code>
          <span style={{ fontStyle: 'italic', fontSize: '12px', color: '#7A7068' }}>
            {chromeCapable ? 'browser automation mode' : 'claude harness only'}
          </span>
        </label>
        {error && (
          <div
            className="capture-error"
            role="alert"
            style={{
              padding: '6px 10px',
              background: 'rgba(178, 78, 60, 0.12)',
              border: '1px solid rgba(178, 78, 60, 0.5)',
              color: '#8B3A28',
              fontSize: '13px',
              borderRadius: '2px',
            }}
          >
            {error}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.3rem' }}>
          <span style={{ fontSize: '11px', color: '#7A7068' }}>
            <kbd>Esc</kbd> cancel · <kbd>⌘↵</kbd> spawn
          </span>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              className="capture-cancel"
              onClick={onCancel}
              disabled={submitting}
              style={btnStyle}
            >
              Cancel
            </button>
            <button
              type="button"
              className="capture-submit"
              onClick={() => void submit()}
              disabled={submitting || !prompt.trim()}
              style={{
                ...btnStyle,
                background: '#3D5BA0', // muted cobalt — matches the ✶ trigger + In Flight accent
                color: '#FFFFFF',
                borderColor: '#2C4378',
                opacity: submitting || !prompt.trim() ? 0.5 : 1,
              }}
            >
              {submitting ? 'Spawning…' : 'Spawn'}
            </button>
          </div>
        </div>
      </div>
    </AppDialog>
  )
}

const labelStyle: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: '#5C544D',
}

const selectStyle: React.CSSProperties = {
  fontFamily: "var(--font-main, 'EB Garamond', serif)",
  fontSize: '14px',
  color: '#2E2A26',
  background: '#FFFFFF',
  border: '1px solid rgba(46, 42, 38, 0.20)',
  borderRadius: '3px',
  padding: '5px 8px',
  width: '100%',
  boxSizing: 'border-box',
}

const btnStyle: React.CSSProperties = {
  fontFamily: "var(--font-main, 'EB Garamond', serif)",
  fontSize: '14px',
  padding: '6px 16px',
  borderRadius: '3px',
  border: '1px solid rgba(46, 42, 38, 0.20)',
  background: 'transparent',
  color: '#5C544D',
  cursor: 'pointer',
}
