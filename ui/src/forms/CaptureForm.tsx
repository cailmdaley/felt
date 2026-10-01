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
import { MEETING_MODES, type MeetingMode } from './meetingApi'
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
 * comes from /api/v1/agents (constraint metadata included), so effort/chrome
 * stay disabled on the fallback (no metadata to gate them).
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
  onMeetingResult: (result: { host: string; error?: string }) => void
  /** Called on cancel / Esc / overlay click. */
  onCancel: () => void
  /** Shuttle daemon base. Defaults to `''` (relative / same-origin). */
  shuttleBase?: string
}

export function CaptureForm({
  projects: availableProjects,
  hosts,
  onProjectAdded,
  onSpawned,
  onMeetingResult,
  onCancel,
  shuttleBase = '',
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
  const [meetingAvailable, setMeetingAvailable] = useState(false)
  const [meetingMode, setMeetingMode] = useState<MeetingMode | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
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
  })

  const meetingEnabled = meetingAvailable && meetingMode !== null

  // Autofocus the yap — it's the whole point of the dialog.
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch(`${shuttleBase}/api/v1/meeting`)
      .then((response) => (response.ok ? response.json() as Promise<{ available?: unknown }> : null))
      .then((status) => {
        if (!cancelled && status?.available === true) setMeetingAvailable(true)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [shuttleBase])

  const agentRec = agents.find((a) => a.id === agent)
  const effectiveEffort = resolveEffort(agentRec, effort)
  const chromeCapable = agentRec?.chrome_capable ?? false

  const handleAgentChange = (id: string): void => {
    const wasCodex = isCodexAgent(agents.find((a) => a.id === agent))
    setAgent(id)
    const rec = agents.find((a) => a.id === id)
    setEffort(resolveEffort(rec, ''))
    if (!(rec?.chrome_capable ?? false)) setChrome(false)
    if (!wasCodex) setSurface(defaultSurface(rec))
  }

  const submit = async (): Promise<void> => {
    if (submitting) return
    const trimmed = prompt.trim()
    if (!trimmed && !meetingEnabled) {
      setError('Say something first — the session needs a yap to work with.')
      textareaRef.current?.focus()
      return
    }
    if (!selectedProject) {
      setError('Pick a project — the capture session needs a directory to land in.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`${shuttleBase}/api/v1/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(captureRequestBody({
          prompt: trimmed,
          projectDir: selectedProject.path,
          origin: selectedProject.originId,
          agent,
          ...(effectiveEffort ? { effort: effectiveEffort } : {}),
          chrome,
          ...(!meetingEnabled && isCodexAgent(agentRec) ? { surface } : {}),
          meetingMode: meetingEnabled ? meetingMode : null,
        })),
      })
      const data = (await res.json().catch(() => ({}))) as CaptureResponseData
      const outcome = captureOutcome(res, data, {
        projectDir: selectedProject.path,
        meetingMode: meetingEnabled ? meetingMode : null,
        host: selectedHost.label,
      })
      if (outcome.kind === 'error') throw new Error(outcome.message)
      if (outcome.kind === 'meeting-recording') {
        onMeetingResult({ host: outcome.host, error: outcome.error })
        return
      }
      onSpawned({
        tmuxSession: outcome.tmuxSession,
        surface: outcome.surface ?? (isCodexAgent(agentRec) ? surface : 'cli'),
      })
    } catch (err) {
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
        if (!next) onCancel()
      }}
      title={meetingEnabled ? 'Start a meeting' : 'New idea'}
      eyebrow="shuttle · capture"
    >
      <div className="form-sheet" onKeyDown={handleKeyDown}>
        <textarea
          ref={textareaRef}
          className="capture-yap"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={meetingEnabled ? "What's the meeting? Who's in it?" : 'Speak the idea — a session will write the card'}
          rows={6}
        />
        {meetingAvailable && (
          <MeetingControl
            mode={meetingEnabled ? meetingMode : null}
            disabled={submitting}
            onChange={setMeetingMode}
          />
        )}
        <div className="form-controls">
          {(projects.length > 0 || onProjectAdded) && (
            <HostProjectFields
              hosts={hosts}
              selectedHostId={selectedHostId}
              onHostChange={handleHostChange}
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
          disabled={submitting || (!meetingEnabled && !prompt.trim())}
          tone="cobalt"
          onCancel={onCancel}
          onSubmit={() => void submit()}
        />
      </div>
    </AppDialog>
  )
}

/**
 * Meeting: a pressed-state button, then the Call | Room | Phone segments. The
 * segments are always laid out and only hidden, so switching meeting on
 * reveals them in space the row already holds and nothing below moves.
 */
export function MeetingControl({ mode, disabled, onChange }: {
  mode: MeetingMode | null
  disabled: boolean
  onChange: (mode: MeetingMode | null) => void
}): JSX.Element {
  return (
    <div className="capture-meeting-row">
      <button
        type="button"
        className="capture-meeting-toggle"
        aria-pressed={mode !== null}
        disabled={disabled}
        onClick={() => onChange(mode === null ? 'call' : null)}
      >
        Meeting
      </button>
      <div
        className="capture-meeting-modes"
        role="radiogroup"
        aria-label="Meeting mode"
        hidden={mode === null}
      >
        {MEETING_MODES.map(({ value, label }) => (
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
        ))}
      </div>
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
    /* One fixed height for the toggle and the segments, and the segments
       hidden by visibility rather than removed: the row is the same box
       whether meeting is on or off. */
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
