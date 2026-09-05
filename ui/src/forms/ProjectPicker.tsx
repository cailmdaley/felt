/**
 * ProjectPicker — the host + project pair both forms use.
 *
 * **Two native `<select>`s, and nothing more.** The project half used to be a
 * bespoke filtering combobox, grown for one reason: a native `<select>` seemed
 * unable to carry the "Add a new project…" row. It can — see the sentinel note
 * below — and the combobox cost far more than it bought. Sitting in a row of
 * native selects (host, project, agent, effort) it read as the odd one out, it
 * could not be sized to match them, and its mouse handling was actually broken:
 * the list portalled into `document.body`, which is the *parent* of this app's
 * React root (`#shuttle-forms-root`), so click events on the portalled rows
 * bubbled straight past the root container where React 18 delegates its
 * listeners. The rows' `onMouseDown` never ran. Keyboard worked; the mouse did
 * nothing. All of that machinery — portal, measured-rect anchoring, capture
 * phase re-measure, filter input, keyboard nav, outside-click — is gone.
 *
 * **Host first, then project.** One flat list mixing every origin made the
 * default selection land wherever recency pointed — often a remote — and then
 * "Add a new project…" quietly meant "on that remote", which is not what
 * anybody clicking it meant. So the host is its own control, to the left,
 * defaulting to the local daemon; the project list is whatever that host owns.
 * A single-host list needs no host suffix on its rows, and the add flow has an
 * unambiguous destination before it starts.
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

/** A host the pickers can point at — one origin of `/api/v1/felt-stores`. */
export interface PickerHost {
  /** `'local'` for the daemon's own host, else the bare remote name. Matches
   *  the projects' `originId`. */
  id: string
  /** How the host reads (the remote's display name, or the local hostname). */
  label: string
  /** This is the daemon's own host. */
  isLocal: boolean
  /** This host can raise an OS folder dialog (`POST /api/v1/choose-folder`). */
  nativeFolderPicker: boolean
}

export interface ProjectPickerProps {
  /** Already in the order the form wants them (recency, then name), and
   *  already scoped to the selected host. */
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

/** Stand-in when the caller passed no host list (an old island, or a degraded
 *  registry fetch): one local host — exactly the pre-split behaviour. */
export const FALLBACK_HOST: PickerHost = {
  id: 'local',
  label: 'local',
  isLocal: true,
  nativeFolderPicker: false,
}

/** Recency first, then name — the default-selection and picker order both
 *  forms present. */
export function byRecency(
  activityById: Record<string, number>,
): <P extends { id: string; name?: string }>(a: P, b: P) => number {
  return (a, b) => {
    const recencyDelta = (activityById[b.id] ?? 0) - (activityById[a.id] ?? 0)
    if (recencyDelta !== 0) return recencyDelta
    return (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, { sensitivity: 'base' })
  }
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
  hosts: PickerHost[]
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
 * headless local daemon): type the absolute path.
 *
 * This replaced an in-browser directory browser that walked the remote
 * filesystem a click at a time over `GET /api/v1/browse`. Once the host is
 * chosen up front, that walk buys nothing a paste of the path doesn't — and
 * the create endpoint already answers 400 with the reason when the path isn't
 * a directory over there, which is the only validation the browser was really
 * providing.
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
              // Same reason as the dropdown's: unhandled, Escape closes the
              // whole form instead of this row.
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
 * Inject the pickers' CSS once — the host and project selects and the remote
 * path-entry row, which are one flow and so one sheet. Idempotent by element
 * id, the same pattern as `injectStashFormStyles`. Safe to call from either
 * form's mount path.
 */
export function injectProjectPickerStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById('project-picker-styles')) return
  const style = document.createElement('style')
  style.id = 'project-picker-styles'
  style.textContent = `
    .projpick-input {
      width: 100%;
      box-sizing: border-box;
      padding: 6px 8px;
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 14px;
      color: #2E2A26;
      background: #FFFFFF;
      border: 1px solid rgba(46, 42, 38, 0.20);
      border-radius: 3px;
    }
    .projpick-input:focus {
      outline: none;
      border-color: rgba(154, 123, 53, 0.55);
      box-shadow: 0 0 0 2px rgba(154, 123, 53, 0.16);
    }
    .projpick-addpath {
      display: flex;
      flex-direction: column;
      gap: 5px;
      padding: 8px 10px;
      background: rgba(154, 123, 53, 0.07);
      border: 1px solid rgba(154, 123, 53, 0.28);
      border-radius: 3px;
    }
    .projpick-addpath-label {
      font-size: 11.5px;
      color: #5C544D;
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
      border: 1px solid rgba(46, 42, 38, 0.20);
      background: transparent;
      color: #5C544D;
      cursor: pointer;
      white-space: nowrap;
    }
    .projpick-addpath-go {
      border-color: rgba(154, 123, 53, 0.55);
      color: #6E5518;
    }
    .projpick-addpath-go:disabled,
    .projpick-addpath-cancel:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .projpick-addpath-error {
      font-size: 12px;
      color: #8B3A28;
    }
  `
  document.head.appendChild(style)
}
