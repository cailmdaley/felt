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
 * the yap (17px, the one field the dialog exists for) is Capture's own.
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
import { agentGroups, resolveEffort, type AgentEntry } from './agents'
import { useAgentRegistry } from './useAgentRegistry'
import type { Host, Project } from './projectModel'
import { AddProjectPath, useProjectSelection } from './ProjectPicker'
import {
  ChromeFlag,
  EffortField,
  Field,
  FormError,
  FormFoot,
  HostProjectFields,
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
  /** Called after an ordinary successful launch. */
  onSpawned: (launch: { tmuxSession: string }) => void
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
  const [mobile] = useState(() => isMobileViewport())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const submittingRef = useRef(false)
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

  useEffect(() => {
    if (!mobile) textareaRef.current?.focus()
  }, [mobile])

  const agentRec = agents.find((a) => a.id === agent)
  const effectiveEffort = resolveEffort(agentRec, effort)
  const chromeCapable = selectedHost.browserCapable && agentRec?.chrome_capable === true

  useEffect(() => {
    if (!chromeCapable) setChrome(false)
  }, [chromeCapable])

  const handleAgentChange = (id: string): void => {
    setAgent(id)
    const rec = agents.find((a) => a.id === id)
    setEffort(resolveEffort(rec, ''))
    if (!(selectedHost.browserCapable && rec?.chrome_capable === true)) setChrome(false)
  }

  const handleCaptureHostChange = (id: string): void => {
    setChrome(false)
    handleHostChange(id)
  }

  const submit = async (): Promise<void> => {
    if (submittingRef.current) return
    const trimmed = prompt.trim()
    if (!trimmed) {
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
          chrome: chrome && chromeCapable,
        })),
      })
      const data = await res.json().catch(() => ({})) as CaptureResponseData
      const outcome = captureOutcome(res, data, { projectDir: selectedProject.path })
      if (outcome.kind === 'error') throw new Error(outcome.message)
      onSpawned({
        tmuxSession: outcome.tmuxSession,
      })
    } catch (err) {
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
      title="New idea"
      eyebrow="shuttle · capture"
      onOpenAutoFocus={mobile ? (event) => event.preventDefault() : undefined}
    >
      <div className="form-sheet" onKeyDown={handleKeyDown}>
        <textarea
          ref={textareaRef}
          className="capture-yap"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Speak the idea — a session will write the card"
          rows={6}
        />
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
          verb="spawn"
          submitLabel={submitting ? 'Spawning…' : 'Spawn'}
          submitting={submitting}
          disabled={submitting || !prompt.trim()}
          tone="cobalt"
          onCancel={onCancel}
          onSubmit={() => void submit()}
        />
      </div>
    </AppDialog>
  )
}

/** The shared form sheet and Capture's prose field. */
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
      font-family: var(--font-serif);
      font-size: var(--type-prose);
      line-height: var(--leading-prose);
      color: var(--kbn-graphite);
      background: var(--kbn-blank);
      border: 1px solid color-mix(in srgb, var(--kbn-graphite) 20%, transparent);
      border-radius: 3px;
      padding: 10px 12px;
      transition: border-color 120ms ease-out, box-shadow 120ms ease-out;
    }
    .capture-yap::placeholder {
      color: var(--kbn-graphite-faint);
      font-style: italic;
    }
    .capture-yap:focus {
      outline: none;
      border-color: color-mix(in srgb, var(--kbn-agent) 70%, var(--kbn-blank));
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--kbn-agent) 16%, transparent);
    }
  `)
}
