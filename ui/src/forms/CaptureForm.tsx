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
 * project picker offers remote projects too.
 *
 * Built on AppDialog (Radix) — focus trap, Esc, portal, scroll lock for free.
 * Cmd/Ctrl+Enter submits. The column, the control row, the session and
 * `--chrome` controls and the footer are formKit's, shared with StashForm;
 * the yap (17px, the one field the dialog exists for) and the meeting row are
 * Capture's own.
 */

import { useEffect, useRef, useState } from 'react'
import { AppDialog } from './AppDialog'
import { injectStyles } from './injectStyles'
import {
  CAPTURE_DEFAULT_AGENT,
  CAPTURE_DEFAULT_EFFORT,
  captureOutcome,
  captureRequestBody,
  type CaptureResponseData,
} from './captureApi'
import { daemonErrorMessage } from '../board/daemonApi'
import { isMobileViewport } from '../board/mobile'
import type { PhoneCaptureAttempt, PhoneCaptureHooks } from '../board/phoneMeeting'
import { parseMeetingRecord, type MeetingRecord } from '../board/meeting'
import { rememberedMeetingProject, rememberMeetingProject } from './meetingProject'
import { MEETING_MODES, parseCaptureMeetingCapabilities, type MeetingMode } from './meetingApi'
import { agentGroups, resolveEffort, useAgentRegistry, type AgentEntry } from './agents'
import type { Host, Project } from './projectModel'
import { defaultSurface, isCodexAgent, type ExecutionSurface } from './executionSurface'
import { AddProjectPath, useProjectSelection } from './ProjectPicker'
import {
  ChromeFlag,
  EffortField,
  Field,
  FormError,
  FormFoot,
  HostProjectFields,
  SessionField,
  injectFormKitStyles,
} from './formKit'

/**
 * Shown until the registry answers, and kept when it cannot. The live list
 * comes from /api/v1/agents (constraint metadata included), so effort stays
 * disabled and --chrome stays hidden on the fallback.
 */
const FALLBACK_AGENTS: AgentEntry[] = [
  { id: 'claude-opus', default: true },
  { id: 'claude-sonnet', default: false },
  { id: 'claude-fable', default: false },
  { id: 'codex', default: false },
]


export interface CaptureFormProps {
  /** Every project, in picker order; each carries its own originId + path. */
  projects: Project[]
  /** Every host the picker can point at — the store registry's origins. The
   *  host control is the left half of the pair; the project list is whatever
   *  the selected host owns. */
  hosts: Host[]
  /** Register a new project directory and hand back the refreshed project set
   *  (the island re-derives it from the daemon). Absent → no add-project row. */
  onProjectAdded?: (path: string) => Promise<Project[]>
  /** Called after an ordinary successful launch. App runs have no tmux name. */
  onSpawned: (launch: { tmuxSession: string; surface: ExecutionSurface }) => void
  /** Called once the daemon confirms meeting recording began. */
  onMeetingResult: (result: { host: string; error?: string; meeting: MeetingRecord | null }) => void
  /** Called on cancel / Esc / overlay click. */
  onCancel: () => void
  /** Shuttle daemon base. Defaults to `''` (relative / same-origin). */
  shuttleBase?: string
  /** Audio belongs to the board, never to this sheet's mount lifetime. */
  phoneAudio?: PhoneCaptureHooks
}

export function CaptureForm({
  projects: availableProjects,
  hosts,
  onProjectAdded,
  onSpawned,
  onMeetingResult,
  onCancel,
  shuttleBase = '',
  phoneAudio,
}: CaptureFormProps): JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [agent, setAgent] = useState<string>(CAPTURE_DEFAULT_AGENT)
  const agents = useAgentRegistry(shuttleBase) ?? FALLBACK_AGENTS
  // Axes come from the selected agent's registry constraint metadata — no
  // hardcoded lists. The effective effort is always a concrete token when
  // the selected agent supports reasoning levels. Seeded to the capture default
  // (xhigh) for the initial opus selection; `handleAgentChange` re-derives from
  // the chosen agent's own default_effort thereafter.
  const [effort, setEffort] = useState<string>(CAPTURE_DEFAULT_EFFORT)
  const [chrome, setChrome] = useState<boolean>(false)
  const [surface, setSurface] = useState<ExecutionSurface>('cli')
  const [mobileMeeting] = useState(() => isMobileViewport())
  const [meetingIntent, setMeetingIntent] = useState(() => mobileMeeting)
  const [meetingMode, setMeetingMode] = useState<MeetingMode | null>(() => mobileMeeting ? 'phone' : null)
  const [meetingCapabilities, setMeetingCapabilities] = useState({
    loading: true,
    available: false,
    modes: [] as MeetingMode[],
  })
  const [initialSelection] = useState(() => mobileMeeting ? rememberedMeetingProject(hosts, availableProjects) : undefined)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const mounted = useRef(true)
  const pendingAudio = useRef<PhoneCaptureAttempt | null>(null)
  const submittingRef = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      pendingAudio.current?.cancel()
    }
  }, [phoneAudio])
  const {
    selectedHostId,
    selectedHost,
    handleHostChange,
    projects,
    hostProjects,
    selectedProjectId,
    setSelectedProjectId,
    selectedProject,
    addProject,
  } = useProjectSelection<Project>({
    shuttleBase,
    projects: availableProjects,
    hosts,
    onProjectAdded,
    initialSelection,
  })

  const meetingModes = meetingCapabilities.available
    ? (mobileMeeting ? meetingCapabilities.modes.filter((mode) => mode === 'phone') : meetingCapabilities.modes)
    : []
  const meetingAvailable = meetingModes.length > 0
  const selectedMeetingMode = meetingMode && meetingModes.includes(meetingMode)
    ? meetingMode
    : meetingModes[0] ?? null
  const meetingEnabled = meetingIntent && selectedMeetingMode !== null
  const recorderHost = hosts.find((host) => host.isLocal) ?? hosts[0]
  const meetingHostLabel = recorderHost && recorderHost.id !== selectedHost.id
    ? `Records on ${recorderHost.label} · scribe on ${selectedHost.label}`
    : undefined

  useEffect(() => {
    if (!mobileMeeting) textareaRef.current?.focus()
  }, [mobileMeeting])

  useEffect(() => {
    let cancelled = false
    setMeetingCapabilities({ loading: true, available: false, modes: [] })
    fetch(`${shuttleBase}/api/v1/meeting`)
      .then((response) => response.ok ? response.json() as Promise<unknown> : null)
      .then((status) => {
        if (!cancelled) {
          const parsed = parseCaptureMeetingCapabilities(status)
          setMeetingCapabilities({ loading: false, ...parsed })
        }
      })
      .catch(() => {
        if (!cancelled) setMeetingCapabilities({ loading: false, available: false, modes: [] })
      })
    return () => { cancelled = true }
  }, [shuttleBase])

  const agentRec = agents.find((a) => a.id === agent)
  const effectiveEffort = resolveEffort(agentRec, effort)
  const chromeCapable = selectedHost.browserCapable && agentRec?.chrome_capable === true

  useEffect(() => {
    if (!chromeCapable) setChrome(false)
  }, [chromeCapable])

  const handleAgentChange = (id: string): void => {
    const wasCodex = isCodexAgent(agents.find((a) => a.id === agent))
    setAgent(id)
    const rec = agents.find((a) => a.id === id)
    setEffort(resolveEffort(rec, ''))
    if (!(selectedHost.browserCapable && rec?.chrome_capable === true)) setChrome(false)
    if (!wasCodex) setSurface(defaultSurface(rec))
  }

  const handleCaptureHostChange = (id: string): void => {
    setChrome(false)
    handleHostChange(id)
  }

  const handleMeetingChange = (mode: MeetingMode | null): void => {
    if (mode === null) {
      setMeetingIntent(false)
    } else {
      setMeetingMode(mode)
      setMeetingIntent(true)
    }
  }

  const submit = async (): Promise<void> => {
    if (submittingRef.current) return
    const trimmed = prompt.trim()
    if (meetingIntent && meetingCapabilities.loading) {
      setError('Meeting availability is still loading.')
      return
    }
    if (!trimmed && !meetingEnabled) {
      setError('Say something first — the session needs a yap to work with.')
      textareaRef.current?.focus()
      return
    }
    if (!selectedProject) {
      setError('Pick a project — the capture session needs a directory to land in.')
      return
    }
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    const requestedMeetingMode = meetingEnabled ? selectedMeetingMode : null
    const phone = requestedMeetingMode === 'phone'
    try {
      // begin reaches AudioContext creation/resume and getUserMedia in this tap,
      // before the first await. The daemon is asked only after the mic succeeds.
      const opening = phone ? phoneAudio?.begin() : null
      if (phone && !opening) throw new Error('Phone audio is unavailable on this board.')
      pendingAudio.current = opening ?? null
      const generation = opening ? await opening.ready : null
      if (!mounted.current) return
      const res = await fetch(`${shuttleBase}/api/v1/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(captureRequestBody({
          prompt: trimmed,
          projectDir: selectedProject.path,
          origin: selectedProject.originId,
          agent,
          ...(effectiveEffort ? { effort: effectiveEffort } : {}),
          chrome: chrome && chromeCapable,
          ...(!meetingEnabled && isCodexAgent(agentRec) ? { surface } : {}),
          meetingMode: requestedMeetingMode,
        })),
      })
      const data = (await res.json().catch(() => ({}))) as CaptureResponseData
      const outcome = captureOutcome(res, data, {
        projectDir: selectedProject.path,
        meetingMode: requestedMeetingMode,
        host: selectedHost.label,
      })
      if (outcome.kind === 'error') throw new Error(outcome.message)
      if (outcome.kind === 'meeting-recording') {
        let recordingError = outcome.error
        try {
          if (phone && generation !== null) {
            if (!mounted.current) throw new Error('Recording started after Capture closed; the mic is off. Connect it from In flight.')
            opening!.bind(generation, data.meeting)
          }
          if (!outcome.error) rememberMeetingProject(selectedProject)
        } catch (err) {
          recordingError = [recordingError, daemonErrorMessage(err)].filter(Boolean).join(' ')
        }
        pendingAudio.current = null
        onMeetingResult({ host: outcome.host, error: recordingError, meeting: parseMeetingRecord(data.meeting) })
        return
      }
      onSpawned({
        tmuxSession: outcome.tmuxSession,
        surface: outcome.surface ?? (isCodexAgent(agentRec) ? surface : 'cli'),
      })
    } catch (err) {
      pendingAudio.current?.cancel()
      pendingAudio.current = null
      submittingRef.current = false
      setError(daemonErrorMessage(err))
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
        if (!next && !submitting) onCancel()
      }}
      title={meetingEnabled ? 'Start a meeting' : 'New idea'}
      eyebrow="shuttle · capture"
      onOpenAutoFocus={mobileMeeting ? (event) => event.preventDefault() : undefined}
    >
      <div className={`form-sheet${mobileMeeting && meetingEnabled ? ' capture-mobile-meeting' : ''}`}  onKeyDown={handleKeyDown}>
        <textarea
          ref={textareaRef}
          className="capture-yap"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={meetingEnabled ? 'Optional — the scribe works it out as you talk' : 'Speak the idea — a session will write the card'}
          rows={mobileMeeting && meetingEnabled ? 2 : 6}
        />
        {(meetingCapabilities.loading || meetingAvailable) && (
          <MeetingControl
            enabled={meetingIntent}
            mode={meetingIntent ? selectedMeetingMode : null}
            modes={meetingModes}
            disabled={submitting || meetingCapabilities.loading}
            onChange={handleMeetingChange}
            defaultMode={meetingModes[0] ?? (mobileMeeting ? 'phone' : 'call')}
            hostLabel={meetingHostLabel}
          />
        )}
        <div className="form-controls">
          {(projects.length > 0 || onProjectAdded) && (
            <HostProjectFields
              hosts={hosts}
              selectedHostId={selectedHostId}
              onHostChange={handleCaptureHostChange}
              projects={hostProjects}
              selectedProjectId={selectedProjectId}
              onProjectChange={setSelectedProjectId}
              onAddProject={onProjectAdded ? addProject.begin : undefined}
            />
          )}
          <Field label="Agent">
            <select
              className="form-select"
              value={agent}
              onChange={(e) => handleAgentChange(e.target.value)}
            >
              {agentGroups(agents).map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.id}{a.id === CAPTURE_DEFAULT_AGENT ? ' (default)' : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <EffortField agent={agentRec} effort={effort} onChange={setEffort} />
          {isCodexAgent(agentRec) && !meetingEnabled && (
            <SessionField surface={surface} onChange={setSurface} />
          )}
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
        <ChromeFlag checked={chrome} capable={chromeCapable} onChange={setChrome} />
        <FormError error={error} />
        <FormFoot
          verb={meetingEnabled ? 'start meeting' : 'spawn'}
          submitLabel={submitting ? (meetingEnabled ? 'Starting…' : 'Spawning…') : meetingEnabled ? 'Start meeting' : 'Spawn'}
          submitting={submitting}
          disabled={submitting || (meetingIntent && meetingCapabilities.loading) || (!meetingEnabled && !prompt.trim())}
          tone="cobalt"
          onCancel={onCancel}
          onSubmit={() => void submit()}
        />
      </div>
    </AppDialog>
  )
}

/** Meeting toggle with mode segments only when the serving daemon offers a choice. */
export function MeetingControl({ enabled, mode, modes, disabled, onChange, defaultMode = 'call', hostLabel }: {
  enabled: boolean
  mode: MeetingMode | null
  modes: MeetingMode[]
  disabled: boolean
  onChange: (mode: MeetingMode | null) => void
  defaultMode?: MeetingMode
  hostLabel?: string
}): JSX.Element {
  const initialMode = modes.includes(defaultMode) ? defaultMode : modes[0] ?? null
  return (
    <div className="capture-meeting-control">
      <div className="capture-meeting-row">
        <button
          type="button"
          className="capture-meeting-toggle"
          aria-pressed={enabled}
          disabled={disabled}
          onClick={() => onChange(enabled ? null : initialMode)}
        >
          Meeting
        </button>
        {modes.length > 1 && (
          <div
            className="capture-meeting-modes"
            role="radiogroup"
            aria-label="Meeting mode"
            hidden={!enabled}
          >
            {modes.map((value) => {
              const label = MEETING_MODES.find((item) => item.value === value)?.label ?? value
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  className="capture-meeting-mode"
                  aria-checked={mode === value}
                  disabled={disabled}
                  onClick={() => onChange(value)}
                >
                  {label}
                </button>
              )
            })}
          </div>
        )}
      </div>
      {hostLabel && <span className="capture-meeting-host-label">{hostLabel}</span>}
    </div>
  )
}

/**
 * Inject the Capture dialog's CSS: the shared form sheet, plus the two parts
 * only Capture has — the yap and the meeting row.
 */
export function injectCaptureFormStyles(): void {
  injectFormKitStyles()
  injectStyles('capture-form-styles', `
    @media (max-width: 700px), (max-height: 500px) and (pointer: coarse) {
      .capture-mobile-meeting .capture-yap { min-height: 3.5rem; resize: none; }
      .capture-mobile-meeting { gap: 10px; }
      .capture-mobile-meeting .capture-meeting-row { min-height: 48px; height: auto; gap: 6px; }
      .capture-mobile-meeting .capture-meeting-toggle { height: 48px; }
      .capture-mobile-meeting .capture-meeting-modes { height: 48px; padding: 1px; }
      .capture-mobile-meeting .capture-meeting-mode { padding: 0 10px; }
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
    /* Keep the toggle and optional mode segments on one control row. */
    .capture-meeting-control {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
      min-width: 0;
    }
    .capture-meeting-host-label {
      max-width: 100%;
      color: #7A7068;
      font-size: 12px;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .capture-meeting-row {
      display: flex;
      align-items: center;
      gap: 10px;
      height: 32px;
    }
    .capture-meeting-toggle {
      box-sizing: border-box;
      height: 32px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 0 14px 0 12px;
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 15px;
      color: #5C544D;
      background: #FFFFFF;
      border: 1px solid rgba(46, 42, 38, 0.20);
      border-radius: 3px;
      cursor: pointer;
      user-select: none;
      transition: background 120ms ease-out, border-color 120ms ease-out, color 120ms ease-out;
    }
    /* A ring that fills when the meeting is on. */
    .capture-meeting-toggle::before {
      content: '';
      box-sizing: border-box;
      width: 10px;
      height: 10px;
      border: 1.5px solid currentColor;
      border-radius: 50%;
    }
    .capture-meeting-toggle:hover:not(:disabled) {
      color: #2E2A26;
      background: rgba(46, 42, 38, 0.04);
    }
    .capture-meeting-toggle[aria-pressed="true"] {
      color: #2F665E;
      background: rgba(63, 130, 120, 0.10);
      border-color: rgba(63, 130, 120, 0.55);
    }
    .capture-meeting-toggle[aria-pressed="true"]::before {
      background: #3F8278;
      border-color: #3F8278;
    }
    .capture-meeting-modes {
      box-sizing: border-box;
      height: 32px;
      display: inline-flex;
      gap: 2px;
      padding: 2px;
      background: rgba(46, 42, 38, 0.035);
      border: 1px solid rgba(46, 42, 38, 0.20);
      border-radius: 3px;
    }
    /* Keep the box, drop the paint, the tab stops and the a11y node. */
    .capture-meeting-modes[hidden] {
      display: inline-flex;
      visibility: hidden;
    }
    .capture-meeting-mode {
      padding: 0 14px;
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 15px;
      line-height: 1;
      color: #7A7068;
      background: transparent;
      border: none;
      border-radius: 2px;
      cursor: pointer;
    }
    .capture-meeting-mode:hover:not([aria-checked="true"]):not(:disabled) {
      color: #2E2A26;
    }
    .capture-meeting-mode[aria-checked="true"] {
      color: #2E2A26;
      background: #FFFFFF;
      box-shadow: 0 0 0 1px rgba(46, 42, 38, 0.12), 0 1px 2px rgba(46, 42, 38, 0.10);
      cursor: default;
    }
    .capture-meeting-toggle:focus-visible,
    .capture-meeting-mode:focus-visible {
      outline: 2px solid rgba(154, 123, 53, 0.45);
      outline-offset: 1px;
    }
    .capture-meeting-toggle:disabled,
    .capture-meeting-mode:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `)
}
