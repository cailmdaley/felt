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
import {
  AddProjectPath,
  HostPicker,
  ProjectPicker,
  projectsForHost,
  type PickerHost,
} from './ProjectPicker'
import { useAddProject } from './useAddProject'

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

/** Stand-in when the caller passed no host list (an old island, or a degraded
 *  registry fetch): one local host — exactly the pre-split behaviour. */
const FALLBACK_HOST: PickerHost = {
  id: 'local',
  label: 'local',
  isLocal: true,
  nativeFolderPicker: false,
}

/** A destination project, as Capture consumes it (Stash's `StashProject`
 *  minus `loomPrefix`, which only parent-nesting needs). */
export interface CaptureProject {
  id: string
  name?: string
  path: string
  originId: string
}

export interface CaptureFormProps {
  /** Default destination: a project path (matched against `availableCities` by
   *  path). Null = fall through to activity ranking. */
  cityPath?: string | null
  /** All connected projects; each carries its own originId + path. */
  availableCities?: CaptureProject[]
  /** Every host the picker can point at — the store registry's origins. The
   *  host control is the left half of the pair; the project list is whatever
   *  the selected host owns. */
  availableHosts?: PickerHost[]
  /** Register a new project directory and hand back the refreshed project set
   *  (the island re-derives it from the daemon). Absent → no add-project row. */
  onProjectAdded?: (path: string) => Promise<CaptureProject[]>
  /** The local daemon can raise its own OS folder dialog. True → the add row on
   *  the local host opens Finder/zenity; every other case asks for the absolute
   *  path on the selected host. Redundant with `availableHosts`' local entry,
   *  and the fallback when no host list came through. */
  nativeFolderPicker?: boolean
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
  availableHosts = [],
  cityActivityById = {},
  onProjectAdded,
  nativeFolderPicker = false,
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
  // Live project set: seeded from the island's derivation, replaced wholesale
  // when the directory picker registers one (the island re-derives it).
  const [cities, setCities] = useState<CaptureProject[]>(availableCities)

  // Same default-selection priority as StashForm: scoped project by path →
  // most-recently-active → alphabetical → null (picker hidden).
  const sortedCities = [...cities].sort((a, b) => {
    const recencyDelta = (cityActivityById[b.id] ?? 0) - (cityActivityById[a.id] ?? 0)
    if (recencyDelta !== 0) return recencyDelta
    return (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, { sensitivity: 'base' })
  })
  // Host first: the local daemon's own, unless the caller scoped the form to a
  // project that lives elsewhere. Defaulting to recency would land on whichever
  // remote was busiest, and "add a project" would then quietly mean "over
  // there" — the thing this split exists to prevent.
  const hosts: PickerHost[] = availableHosts.length > 0 ? availableHosts : [FALLBACK_HOST]
  const scopedCity = cityPath ? availableCities.find((c) => c.path === cityPath) ?? null : null
  const [selectedHostId, setSelectedHostId] = useState<string>(
    () => scopedCity?.originId ?? hosts.find((h) => h.isLocal)?.id ?? hosts[0].id,
  )
  const [selectedCityId, setSelectedCityId] = useState<string | null>(
    () => scopedCity?.id ?? projectsForHost(sortedCities, scopedCity?.originId ?? hosts.find((h) => h.isLocal)?.id ?? hosts[0].id)[0]?.id ?? null,
  )
  const hostCities = projectsForHost(sortedCities, selectedHostId)
  const selectedHost = hosts.find((h) => h.id === selectedHostId) ?? hosts[0]


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
      .then((raw: AgentEntry[] | null) => {
        if (cancelled || !Array.isArray(raw)) return
        const list = raw.filter((a) => !a.alias_of)
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

  const selectedCity = hostCities.find((c) => c.id === selectedCityId) ?? null

  // The add-project row — native OS dialog on a local host that has one, the
  // absolute-path row everywhere else (see useAddProject).
  const addProject = useAddProject<CaptureProject>({
    shuttleBase,
    nativeFolderPicker: selectedHost.isLocal
      ? selectedHost.nativeFolderPicker || nativeFolderPicker
      : false,
    isLocalHost: selectedHost.isLocal,
    origin: selectedHostId,
    onProjectAdded,
    onAdded: (next, path) => {
      setCities(next)
      const added = next.find((c) => c.path === path && c.originId === selectedHostId)
      if (added) setSelectedCityId(added.id)
    },
  })

  // Changing the host re-points the project at that host's most recent one — a
  // selection belonging to the previous host would submit to the wrong machine,
  // and null would silently block submit. Any open path row belongs to the old
  // host, so it goes too.
  const handleHostChange = (id: string): void => {
    setSelectedHostId(id)
    setSelectedCityId(projectsForHost(sortedCities, id)[0]?.id ?? null)
    addProject.closePath()
  }

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
        {/* Host · project · agent · effort — four native selects, four equal
            columns. `flex: 1 1 0` with `min-width: 0` is what makes them equal
            regardless of the longest option text; the 7rem basis in the wrap
            breakpoint keeps the small-screen collapse. */}
        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
          {/* Host, then project — the same pair Stash uses. The project half is
              a native <select> too: its "Add a new project…" entry is a
              sentinel option, restored on change, so it never becomes a
              selected state (see ProjectPicker). */}
          {(cities.length > 0 || onProjectAdded) && (
            <>
              <div style={{ flex: '1 1 7rem', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                <span className="capture-label" style={labelStyle}>Host</span>
                <HostPicker hosts={hosts} selectedId={selectedHostId} onSelect={handleHostChange} />
              </div>
              <div style={{ flex: '1 1 7rem', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                <span className="capture-label" style={labelStyle}>Project</span>
                <ProjectPicker
                  projects={hostCities}
                  selectedId={selectedCityId}
                  onSelect={setSelectedCityId}
                  onAddProject={onProjectAdded ? addProject.begin : undefined}
                />
              </div>
            </>
          )}
          <label style={{ flex: '1 1 7rem', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
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
          <label style={{ flex: '1 1 7rem', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
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
        {addProject.pathOpen && onProjectAdded && (
          <AddProjectPath
            hostLabel={selectedHost.label}
            busy={addProject.busy}
            error={addProject.pathError}
            onSubmit={addProject.submitPath}
            onCancel={addProject.closePath}
          />
        )}
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
