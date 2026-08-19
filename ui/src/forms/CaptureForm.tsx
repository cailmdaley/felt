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
 *
 * **One sheet, one grid.** Everything inside the card is styled by
 * `injectCaptureFormStyles` (below), not by inline objects. That is what keeps
 * the yap, the four-control row and the footer on a single alignment grid:
 * every block is a full-width child of `.capture-form`, and all four selects
 * share one `.capture-select` rule, so their boxes are identical by
 * construction rather than by two style sources agreeing. The type scale is
 * Stash's — 19px title, 15px controls, 11px labels — with the yap itself at
 * 17px, since it is the one field the whole dialog exists for.
 */

import { useEffect, useRef, useState } from 'react'
import { AppDialog } from './AppDialog'
import type { AgentEntry } from './StashForm'
import { shuttleOrigin } from './projectModel'
import {
  AddProjectPath,
  HostPicker,
  ProjectPicker,
  injectProjectPickerStyles,
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
      eyebrow="shuttle · capture"
    >
      <div className="capture-form" onKeyDown={handleKeyDown}>
        <textarea
          ref={textareaRef}
          className="capture-yap"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Speak the idea — a session will write the card"
          rows={6}
        />
        {/* Host · project · agent · effort — four equal grid columns rather
            than flex children, so the last column's right edge is the
            container's right edge exactly, and a narrow card breaks 2×2
            instead of stranding one control on its own row. */}
        <div className="capture-controls">
          {/* Host, then project — the same pair Stash uses. The project half is
              a native <select> too: its "Add a new project…" entry is a
              sentinel option, restored on change, so it never becomes a
              selected state (see ProjectPicker). */}
          {(cities.length > 0 || onProjectAdded) && (
            <>
              <div className="capture-field">
                <span className="capture-label">Host</span>
                <HostPicker
                  hosts={hosts}
                  selectedId={selectedHostId}
                  onSelect={handleHostChange}
                  className="capture-select"
                />
              </div>
              <div className="capture-field">
                <span className="capture-label">Project</span>
                <ProjectPicker
                  projects={hostCities}
                  selectedId={selectedCityId}
                  onSelect={setSelectedCityId}
                  onAddProject={onProjectAdded ? addProject.begin : undefined}
                  className="capture-select"
                />
              </div>
            </>
          )}
          <label className="capture-field">
            <span className="capture-label">Agent</span>
            <select
              className="capture-select capture-agent"
              value={agent}
              onChange={(e) => handleAgentChange(e.target.value)}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id}{a.id === CAPTURE_DEFAULT_AGENT ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="capture-field">
            <span className="capture-label">Effort</span>
            <select
              className="capture-select capture-effort"
              value={effectiveEffort}
              onChange={(e) => setEffort(e.target.value)}
              disabled={effortLevels.length === 0}
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
          className={`capture-chrome${chromeCapable ? '' : ' capture-chrome-off'}`}
        >
          <input
            type="checkbox"
            checked={chrome}
            disabled={!chromeCapable}
            onChange={(e) => setChrome(e.target.checked)}
          />
          <code>--chrome</code>
          <span className="capture-chrome-hint">
            {chromeCapable ? 'browser automation mode' : 'claude harness only'}
          </span>
        </label>
        {error && (
          <div className="capture-error" role="alert">
            {error}
          </div>
        )}
        <div className="capture-foot">
          <span className="capture-foot-hint">
            <kbd>Esc</kbd> cancel <span className="capture-foot-dot">·</span> <kbd>⌘↵</kbd> spawn
          </span>
          <div className="capture-buttons">
            <button
              type="button"
              className="capture-btn capture-cancel"
              onClick={onCancel}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="capture-btn capture-submit"
              onClick={() => void submit()}
              disabled={submitting || !prompt.trim()}
            >
              {submitting ? 'Spawning…' : 'Spawn'}
            </button>
          </div>
        </div>
      </div>
    </AppDialog>
  )
}

/**
 * Inject the Capture dialog's CSS once — idempotent by element id, the same
 * pattern as `injectStashFormStyles`. The shared pickers' sheet rides along,
 * because `AddProjectPath` still draws from it.
 *
 * Every measurable value the alignment depends on lives here and nowhere else:
 * `.capture-form`'s children are all full-width blocks on one column, and the
 * four controls share `.capture-select`, so equal boxes are a property of the
 * markup rather than a coincidence between two style sources.
 */
export function injectCaptureFormStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById('capture-form-styles')) return
  const style = document.createElement('style')
  style.id = 'capture-form-styles'
  style.textContent = `
    .capture-form {
      display: flex;
      flex-direction: column;
      gap: 14px;
      font-family: var(--font-main, 'EB Garamond', serif);
      color: #2E2A26;
    }
    .capture-form > * {
      box-sizing: border-box;
    }
    /* The yap. 17px because this is the dialog's one piece of prose — the
       controls beneath it read at 15px, the labels at 11px. */
    .capture-yap {
      width: 100%;
      box-sizing: border-box;
      resize: vertical;
      min-height: 8.5rem;
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 17px;
      line-height: 1.5;
      color: #2E2A26;
      background: #FFFFFF;
      border: 1px solid rgba(46, 42, 38, 0.20);
      border-radius: 3px;
      padding: 10px 12px;
      transition: border-color 120ms ease-out, box-shadow 120ms ease-out;
    }
    .capture-yap::placeholder {
      color: #9A8E80;
      font-style: italic;
    }
    .capture-yap:focus {
      outline: none;
      border-color: #7C93C8;
      box-shadow: 0 0 0 2px rgba(61, 91, 160, 0.16);
    }
    .capture-controls {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }
    @media (max-width: 640px) {
      .capture-controls {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    .capture-field {
      display: flex;
      flex-direction: column;
      gap: 5px;
      min-width: 0;
    }
    .capture-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #5C544D;
      line-height: 1;
    }
    /* One rule for all four controls. Custom chevron (so the four boxes are
       identical rather than at the mercy of native select metrics) and
       border-box sizing, so each column's control fills its track exactly. */
    .capture-select {
      width: 100%;
      box-sizing: border-box;
      appearance: none;
      -webkit-appearance: none;
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 15px;
      line-height: 1.3;
      color: #2E2A26;
      background-color: #FFFFFF;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%237A7068'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 10px center;
      border: 1px solid rgba(46, 42, 38, 0.20);
      border-radius: 3px;
      padding: 7px 28px 7px 9px;
      cursor: pointer;
      transition: border-color 120ms ease-out, box-shadow 120ms ease-out;
    }
    .capture-select:focus {
      outline: none;
      border-color: #C49333;
      box-shadow: 0 0 0 2px rgba(154, 123, 53, 0.18);
    }
    .capture-select:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .capture-chrome {
      display: inline-flex;
      align-items: center;
      align-self: flex-start;
      gap: 8px;
      font-size: 13px;
      color: #2E2A26;
      cursor: pointer;
      user-select: none;
    }
    .capture-chrome-off {
      cursor: not-allowed;
      opacity: 0.45;
    }
    .capture-chrome input[type="checkbox"] {
      width: 14px;
      height: 14px;
      margin: 0;
      accent-color: #3D5BA0;
      cursor: inherit;
    }
    .capture-chrome code {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 12px;
      background: rgba(46, 42, 38, 0.06);
      padding: 1px 5px;
      border-radius: 2px;
      color: #2C4378;
    }
    .capture-chrome-hint {
      font-style: italic;
      font-size: 12px;
      color: #7A7068;
    }
    .capture-error {
      padding: 8px 10px;
      background: rgba(178, 78, 60, 0.12);
      border: 1px solid rgba(178, 78, 60, 0.5);
      color: #8B3A28;
      font-size: 13px;
      border-radius: 2px;
    }
    /* The footer sits below a hairline, the way Stash's does below its body. */
    .capture-foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-top: 2px;
      padding-top: 13px;
      border-top: 1px solid rgba(46, 42, 38, 0.10);
    }
    .capture-foot-hint {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      color: #7A7068;
    }
    .capture-foot-dot {
      color: #B5A998;
    }
    .capture-foot-hint kbd {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 10px;
      background: rgba(46, 42, 38, 0.10);
      padding: 1px 5px;
      border-radius: 2px;
      border: 1px solid rgba(46, 42, 38, 0.16);
      color: #4C453F;
    }
    .capture-buttons {
      display: flex;
      gap: 8px;
    }
    .capture-btn {
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 15px;
      letter-spacing: 0.01em;
      padding: 6px 18px;
      border-radius: 3px;
      border: 1px solid transparent;
      cursor: pointer;
      transition: background 120ms ease-out, border-color 120ms ease-out;
    }
    .capture-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .capture-cancel {
      background: transparent;
      color: #7A7068;
      border-color: rgba(46, 42, 38, 0.20);
    }
    .capture-cancel:hover:not(:disabled) {
      background: rgba(46, 42, 38, 0.06);
      color: #2E2A26;
    }
    /* Muted cobalt — matches the ✶ trigger and the In Flight lane accent. */
    .capture-submit {
      background: #3D5BA0;
      color: #FFFFFF;
      border-color: #2C4378;
      box-shadow: 0 1px 0 rgba(255, 252, 245, 0.22) inset;
    }
    .capture-submit:hover:not(:disabled) {
      background: #35508F;
    }
  `
  document.head.appendChild(style)
  injectProjectPickerStyles()
}
