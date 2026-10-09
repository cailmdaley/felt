/**
 * ProjectPicker — the host + project pair both forms use.
 *
 * **Two native `<select>`s**, sized and keyed like the agent and effort
 * selects beside them. A custom combobox would read as the odd one out in that
 * row, and a portalled list would sit outside `#shuttle-forms-root`, where
 * React 18 delegates its listeners, so its mouse events would never arrive.
 *
 * **Host first, then project.** The host is its own control, to the left,
 * defaulting to the local daemon; the project list is whatever that host owns.
 * "Add a new project…" then has an unambiguous destination before it starts,
 * and a single-host list needs no host suffix on its rows.
 *
 * **Why the magic option is safe here.** The two things that make a magic
 * `<option>` a trap are both answered:
 *
 *   * It sits alone in its own `<optgroup>`, first, so it is visually apart
 *     from the projects and cannot be misread as one of them.
 *   * It is a *sentinel*, never a state. `onChange` seeing it runs the add flow
 *     and immediately puts the field back on the project it was showing — both
 *     by leaving the controlled `value` untouched and by writing the previous
 *     value back onto the DOM node, so the select never sits displaying "Add a
 *     new project…" no matter how it was reached (mouse, arrows, type-ahead).
 *
 * The placeholder shown when nothing is selected is `disabled`, so type-ahead
 * and arrow keys cannot land on it either.
 */

import { useEffect, useRef, useState } from 'react'
import type { Host } from './projectModel'
import { injectStyles } from './injectStyles'
import { useAddProject, type AddProjectFlow } from './useAddProject'

export interface PickerProject {
  /** Stable key — `${originId}:${path}`. */
  id: string
  name?: string
  /** `shuttle.project_dir` — the worker cwd AND the create endpoint's felt root. */
  path: string
  /** Owner-routing key sent as `origin`: `'local'` for the local daemon's own
   *  projects, else the owning remote's bare name (e.g. `cluster-a`). */
  originId: string
}

export interface ProjectPickerProps {
  /** Already in picker order and scoped to the selected host. */
  projects: PickerProject[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** The "Add a new project…" option's handler. Absent → no add option. */
  onAddProject?: () => void
  /** The host form's own select class, so the project sits in the same visual
   *  family as the agent/effort selects beside it. */
  className: string
}

const ADD_LABEL = 'Add a new project…'

/** The value the add option carries. Never a selection — `onChange` runs the
 *  add flow and restores the previous project. Exported for the unit test. */
export const ADD_PROJECT_VALUE = '__add_project__'

/** How a project reads in the select. The host is chosen next door, so this
 *  never qualifies with an origin. */
export function projectLabel(project: PickerProject): string {
  return project.name ?? project.id
}

/** The projects one host owns, in the order they came in. The single place the
 *  host selection narrows the project list. */
export function projectsForHost<P extends { originId: string }>(
  projects: P[],
  hostId: string | null,
): P[] {
  if (!hostId) return []
  return projects.filter((p) => p.originId === hostId)
}

/**
 * What a `change` on the project select means. Pure, so the sentinel rule is
 * testable without a DOM: `'add'` runs the add flow and leaves the selection
 * alone, `'select'` carries a real project id, `'ignore'` is the disabled
 * placeholder (which the browser should never fire, but a stray `''` must not
 * become a selection).
 */
export function interpretProjectChange(
  value: string,
): { kind: 'add' } | { kind: 'select'; id: string } | { kind: 'ignore' } {
  if (value === ADD_PROJECT_VALUE) return { kind: 'add' }
  if (value === '') return { kind: 'ignore' }
  return { kind: 'select', id: value }
}

/**
 * The project half of the pair: a native `<select>`, sized and keyed exactly
 * like the host, agent and effort selects beside it.
 */
export function ProjectPicker({
  projects,
  selectedId,
  onSelect,
  onAddProject,
  className,
}: ProjectPickerProps): JSX.Element {
  // Only a project actually on this host may show as selected; a stale id from
  // the previous host falls back to the placeholder rather than a blank field.
  const value = selectedId && projects.some((p) => p.id === selectedId) ? selectedId : ''

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const outcome = interpretProjectChange(e.target.value)
    if (outcome.kind === 'select') {
      onSelect(outcome.id)
      return
    }
    // Put the field straight back on what it was showing. The controlled
    // `value` already says so, but React only rewrites the node if it
    // re-renders — and nothing here changes state, so write it back directly.
    e.target.value = value
    if (outcome.kind === 'add') onAddProject?.()
  }

  return (
    <select className={className} value={value} onChange={handleChange}>
      {value === '' && (
        <option value="" disabled>
          {projects.length > 0 ? 'Choose a project…' : 'No projects on this host yet'}
        </option>
      )}
      {onAddProject && (
        <optgroup label="New">
          <option value={ADD_PROJECT_VALUE}>{ADD_LABEL}</option>
        </optgroup>
      )}
      {projects.length > 0 && (
        <optgroup label="Projects">
          {projects.map((p) => (
            <option key={p.id} value={p.id} title={p.path}>
              {projectLabel(p)}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  )
}

export interface HostPickerProps {
  hosts: Host[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** See `ProjectPickerProps.className`. */
  className: string
}

/**
 * The host half of the pair. A native `<select>`: the list is short and closed
 * (hosts come from the daemon's remote config, never from this form), and it
 * carries no add option.
 */
export function HostPicker({
  hosts,
  selectedId,
  onSelect,
  className,
}: HostPickerProps): JSX.Element {
  return (
    <select
      className={className}
      value={selectedId ?? ''}
      onChange={(e) => onSelect(e.target.value)}
    >
      {hosts.map((h) => (
        <option key={h.id} value={h.id}>
          {h.label}
          {/* "· local", not "(this machine)": at a quarter of the card the
              longer suffix truncated the hostname itself away. */}
          {h.isLocal ? ' · local' : ''}
        </option>
      ))}
    </select>
  )
}

export interface AddProjectPathProps {
  /** The host the path will be interpreted on — named in the prompt, because
   *  an absolute path means nothing without knowing whose filesystem it is. */
  hostLabel: string
  busy: boolean
  error: string | null
  onSubmit: (path: string) => void
  onCancel: () => void
}

/**
 * Add-a-project on a host with no OS dialog to raise (every remote, and any
 * headless local daemon): type the absolute path. The owner-routed create
 * answers 400 with the reason when the path is not a directory over there,
 * and that reason is shown in the row.
 */
export function AddProjectPath({
  hostLabel,
  busy,
  error,
  onSubmit,
  onCancel,
}: AddProjectPathProps): JSX.Element {
  const [path, setPath] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = (): void => {
    const trimmed = path.trim()
    if (trimmed && !busy) onSubmit(trimmed)
  }

  return (
    <div className="projpick-addpath">
      <span className="projpick-addpath-label">
        Absolute path on <strong>{hostLabel}</strong>
      </span>
      <div className="projpick-addpath-row">
        <input
          ref={inputRef}
          type="text"
          className="projpick-input projpick-addpath-input"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              // Unhandled, Escape would close the whole form instead of
              // this row.
              e.preventDefault()
              e.stopPropagation()
              onCancel()
            }
          }}
          placeholder="/home/you/projects/thing"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="projpick-addpath-go"
          onClick={submit}
          disabled={busy || !path.trim()}
        >
          {busy ? 'Adding…' : 'Add'}
        </button>
        <button type="button" className="projpick-addpath-cancel" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
      {error && (
        <div className="projpick-addpath-error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}

/**
 * Inject the pickers' CSS — the host and project selects and the path-entry
 * row, which are one flow and so one sheet. Both forms' sheets pull it in.
 */
export function injectProjectPickerStyles(): void {
  injectStyles('project-picker-styles', `
    .projpick-input {
      width: 100%;
      box-sizing: border-box;
      padding: 6px 8px;
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 14px;
      color: var(--kbn-graphite);
      background: var(--kbn-blank);
      border: 1px solid color-mix(in srgb, var(--kbn-graphite) 20%, transparent);
      border-radius: 3px;
    }
    .projpick-input:focus {
      outline: none;
      border-color: color-mix(in srgb, var(--kbn-owed) 55%, transparent);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--kbn-owed) 16%, transparent);
    }
    .projpick-addpath {
      display: flex;
      flex-direction: column;
      gap: 5px;
      padding: 8px 10px;
      background: color-mix(in srgb, var(--kbn-owed) 7%, transparent);
      border: 1px solid color-mix(in srgb, var(--kbn-owed) 28%, transparent);
      border-radius: 3px;
    }
    .projpick-addpath-label {
      font-size: 11.5px;
      color: var(--kbn-graphite-soft);
    }
    .projpick-addpath-row {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .projpick-addpath-input {
      flex: 1 1 auto;
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 12.5px;
    }
    .projpick-addpath-go,
    .projpick-addpath-cancel {
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 13px;
      padding: 5px 12px;
      border-radius: 3px;
      border: 1px solid color-mix(in srgb, var(--kbn-graphite) 20%, transparent);
      background: transparent;
      color: var(--kbn-graphite-soft);
      cursor: pointer;
      white-space: nowrap;
    }
    .projpick-addpath-go {
      border-color: color-mix(in srgb, var(--kbn-owed) 55%, transparent);
      color: color-mix(in srgb, var(--kbn-owed-bright) 54%, var(--kbn-ink));
    }
    .projpick-addpath-go:disabled,
    .projpick-addpath-cancel:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .projpick-addpath-error {
      font-size: 12px;
      color: var(--kbn-error);
    }
  `)
}

/**
 * Host-then-project selection — the state both forms run on, once.
 *
 * Capture and Stash ask the same question in the same order (which host, then
 * which of its projects), with the same defaults, the same re-point on a host
 * change, and the same adopt-and-select on "+ Add project…". Only the JSX
 * around it differs, so only the JSX stays in the forms.
 */
export function useProjectSelection<P extends PickerProject>(opts: {
  shuttleBase: string
  /** Every project, in picker order (most recently active first). */
  projects: P[]
  /** Every host, never empty — `deriveHosts` always yields the local one. */
  hosts: Host[]
  onProjectAdded?: (path: string) => Promise<P[]>
  initialSelection?: { hostId: string; projectId: string }
}): {
  selectedHostId: string
  selectedHost: Host
  handleHostChange: (id: string) => void
  projects: P[]
  hostProjects: P[]
  selectedProjectId: string | null
  setSelectedProjectId: (id: string | null) => void
  selectedProject: P | null
  addProject: AddProjectFlow
} {
  // Live project set: seeded from the island's derivation, replaced wholesale
  // when the add flow registers one (the island re-derives it, so the shape
  // stays single-sourced there).
  const [projects, setProjects] = useState<P[]>(opts.projects)

  // Host first: the local daemon's own. Defaulting to recency would land on
  // whichever remote was busiest, and "add a project" would then quietly mean
  // "over there".
  const { hosts } = opts
  const defaultHostId = opts.initialSelection?.hostId ?? hosts.find((h) => h.isLocal)?.id ?? hosts[0].id
  const [selectedHostId, setSelectedHostId] = useState<string>(defaultHostId)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    () => opts.initialSelection?.projectId ?? projectsForHost(projects, defaultHostId)[0]?.id ?? null,
  )
  const hostProjects = projectsForHost(projects, selectedHostId)
  const selectedHost = hosts.find((h) => h.id === selectedHostId) ?? hosts[0]
  const selectedProject = hostProjects.find((p) => p.id === selectedProjectId) ?? null

  // The add-project row — native OS dialog on a local host that has one, the
  // absolute-path row everywhere else (see useAddProject).
  const addProject = useAddProject<P>({
    shuttleBase: opts.shuttleBase,
    nativeFolderPicker: selectedHost.isLocal && selectedHost.nativeFolderPicker,
    origin: selectedHostId,
    onProjectAdded: opts.onProjectAdded,
    onAdded: (next, path) => {
      setProjects(next)
      const added = next.find((p) => p.path === path && p.originId === selectedHostId)
      if (added) setSelectedProjectId(added.id)
    },
  })

  // Changing the host re-points the project at that host's most recent one — a
  // selection belonging to the previous host would act on the wrong machine,
  // and null would silently block submit. Any open path row belongs to the old
  // host, so it goes too.
  const handleHostChange = (id: string): void => {
    setSelectedHostId(id)
    setSelectedProjectId(projectsForHost(projects, id)[0]?.id ?? null)
    addProject.closePath()
  }

  return {
    selectedHostId,
    selectedHost,
    handleHostChange,
    projects,
    hostProjects,
    selectedProjectId,
    setSelectedProjectId,
    selectedProject,
    addProject,
  }
}
