/**
 * ProjectPicker — the host + project pair both forms use.
 *
 * Stash grew a filtering combobox while Capture kept a native `<select>`, and
 * the two drifted: only one of them could carry the "+ Add project…" row, since
 * a native `<select>` cannot host an option that acts as a button (a magic
 * `<option>` breaks keyboard selection and reads as a project you can pick).
 * This is that combobox extracted, so both forms get the same one.
 *
 * **Host first, then project.** One flat list mixing every origin made the
 * default selection land wherever recency pointed — often a remote — and then
 * "Add a new project…" quietly meant "on that remote", which is not what
 * anybody clicking it meant. So the host is now its own control, to the left,
 * defaulting to the local daemon; the project list is whatever that host owns.
 * A short single-host list needs no host suffix on its rows, and the add flow
 * has an unambiguous destination before it starts.
 *
 * Two things the project combobox insists on:
 *
 *   * **"Add a new project…" is the FIRST row**, not a trailing footer and
 *     never a button beside the field. Opening the picker on a host with no
 *     projects yet shows the way in as the first thing you read.
 *   * **Keyboard parity with `ParentPicker`** — ↑/↓ walk the rows (the add row
 *     included), Enter commits the highlighted one, Escape closes the dropdown
 *     and stops there. Escape's `stopPropagation` is load-bearing inside
 *     Capture's Radix dialog: without it the key bubbles up and closes the
 *     whole form instead of the list.
 *
 * **Why the dropdown is portalled, not absolutely positioned.** Both hosts clip
 * it: Stash's `.stash-card` is `overflow: hidden` over a scrolling
 * `.stash-body`, and Capture's Radix content is `overflow: auto` with a
 * `max-height`. An `position: absolute` list is still *in* that scroll box, so
 * opening it grew the card and stranded the rows below the fold with no way to
 * reach them. The list is therefore rendered into `document.body` at
 * `position: fixed`, anchored to the input's measured rect and re-measured on
 * scroll/resize. It owns no layout in either host, and its z-index clears the
 * Radix dialog (10001).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface PickerProject {
  /** Stable key — `${originId}:${path}`. */
  id: string
  name?: string
  path: string
  /** `'local'` or a remote host name. */
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
  /** The "Add a new project…" row's handler. Absent → no add row. */
  onAddProject?: () => void
  /** Field id, so a caller's `<label>` can point at the input. */
  inputId?: string
}

const ADD_LABEL = 'Add a new project…'

/** How a project reads in the closed field and in a row's title line. The host
 *  is chosen next door, so this never qualifies with an origin. */
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

/** Case-insensitive match over name and path — the list is single-host now, so
 *  the origin is no longer worth matching. Exported for the unit test. */
export function filterProjects(projects: PickerProject[], query: string): PickerProject[] {
  const q = query.trim().toLowerCase()
  if (!q) return projects
  return projects.filter(
    (p) => (p.name ?? p.id).toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
  )
}

/** Where the portalled dropdown sits: the input's rect, in viewport coords. */
interface Anchor {
  left: number
  top: number
  width: number
}

export function ProjectPicker({
  projects,
  selectedId,
  onSelect,
  onAddProject,
  inputId,
}: ProjectPickerProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [highlight, setHighlight] = useState(-1)
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const selected = projects.find((p) => p.id === selectedId) ?? null
  const filtered = filterProjects(projects, filter)
  // The row list the keyboard walks: the add row first, then the projects. One
  // array so ↑/↓ can't disagree with what is painted.
  const rows: Array<{ kind: 'add' } | { kind: 'project'; project: PickerProject }> = [
    ...(onAddProject ? [{ kind: 'add' as const }] : []),
    ...filtered.map((project) => ({ kind: 'project' as const, project })),
  ]

  // Anchor the fixed list to the input, and keep it there while the page or
  // either host's scroll container moves under it (capture phase, so a scroll
  // on any ancestor counts).
  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null)
      return
    }
    const measure = (): void => {
      const rect = inputRef.current?.getBoundingClientRect()
      if (rect) setAnchor({ left: rect.left, top: rect.bottom + 4, width: rect.width })
    }
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node
      // The list lives in a portal, outside `wrapRef` — it has to be checked
      // separately or dragging its scrollbar would close it.
      if (wrapRef.current?.contains(target) || listRef.current?.contains(target)) return
      close()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [open])

  function close(): void {
    setOpen(false)
    setFilter('')
    setHighlight(-1)
  }

  function commit(row: (typeof rows)[number]): void {
    close()
    inputRef.current?.blur()
    if (row.kind === 'add') onAddProject?.()
    else onSelect(row.project.id)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      setHighlight((h) => Math.min(rows.length - 1, h + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(-1, h - 1))
    } else if (e.key === 'Enter') {
      if (open && highlight >= 0 && rows[highlight]) {
        e.preventDefault()
        commit(rows[highlight])
      }
    } else if (e.key === 'Escape') {
      if (open) {
        // Consume Escape so it dismisses only the dropdown — unhandled it
        // bubbles to the host dialog and closes the whole form.
        e.preventDefault()
        e.stopPropagation()
        close()
      }
    }
  }

  const list = (
    <div
      className="projpick-list"
      role="listbox"
      ref={listRef}
      style={
        anchor
          ? { left: `${anchor.left}px`, top: `${anchor.top}px`, width: `${anchor.width}px` }
          : { visibility: 'hidden' }
      }
    >
      {rows.map((row, i) =>
        row.kind === 'add' ? (
          <button
            key="__add__"
            type="button"
            className={`projpick-add${i === highlight ? ' projpick-option-active' : ''}`}
            onMouseDown={(e) => {
              e.preventDefault()
              commit(row)
            }}
            onMouseEnter={() => setHighlight(i)}
          >
            {ADD_LABEL}
          </button>
        ) : (
          <button
            key={`${row.project.originId}:${row.project.id}`}
            type="button"
            className={`projpick-option${
              row.project.id === selectedId ? ' projpick-option-selected' : ''
            }${i === highlight ? ' projpick-option-active' : ''}`}
            role="option"
            aria-selected={row.project.id === selectedId}
            onMouseDown={(e) => {
              e.preventDefault()
              commit(row)
            }}
            onMouseEnter={() => setHighlight(i)}
          >
            <span>{row.project.name ?? row.project.id}</span>
            <span className="projpick-meta">{row.project.path}</span>
          </button>
        ),
      )}
      {filtered.length === 0 && (
        <div className="projpick-empty">
          {filter.trim()
            ? `No project matches "${filter}".`
            : 'No projects on this host yet.'}
        </div>
      )}
    </div>
  )

  return (
    <div className="projpick" ref={wrapRef}>
      <input
        id={inputId}
        ref={inputRef}
        type="text"
        className="projpick-input"
        value={open ? filter : selected ? projectLabel(selected) : ''}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          setFilter(e.target.value)
          setHighlight(-1)
        }}
        onKeyDown={handleKeyDown}
        readOnly={!open}
        placeholder="search projects…"
        autoComplete="off"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
      />
      {open && typeof document !== 'undefined' && createPortal(list, document.body)}
    </div>
  )
}

export interface HostPickerProps {
  hosts: PickerHost[]
  selectedId: string | null
  onSelect: (id: string) => void
  inputId?: string
}

/**
 * The host half of the pair. A native `<select>` and nothing more: the list is
 * short, closed (hosts come from the daemon's remote config, never from this
 * form), and carries no add row — so the reasons ProjectPicker had to grow its
 * own combobox don't apply here.
 */
export function HostPicker({ hosts, selectedId, onSelect, inputId }: HostPickerProps): JSX.Element {
  return (
    <select
      id={inputId}
      className="projpick-host"
      value={selectedId ?? ''}
      onChange={(e) => onSelect(e.target.value)}
    >
      {hosts.map((h) => (
        <option key={h.id} value={h.id}>
          {h.label}
          {h.isLocal ? ' (this machine)' : ''}
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
 * Inject the pickers' CSS once — the project combobox, the host select, and the
 * remote path-entry row, which are one flow and so one sheet. Idempotent by
 * element id, the same pattern as `injectStashFormStyles`. Safe to call from
 * either form's mount path.
 */
export function injectProjectPickerStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById('project-picker-styles')) return
  const style = document.createElement('style')
  style.id = 'project-picker-styles'
  style.textContent = `
    .projpick {
      position: relative;
    }
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
    .projpick-host {
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
    .projpick-host:focus {
      outline: none;
      border-color: rgba(154, 123, 53, 0.55);
      box-shadow: 0 0 0 2px rgba(154, 123, 53, 0.16);
    }
    /* Portalled to <body> and fixed: it must not occupy layout in Stash's card
       or Capture's Radix content, both of which clip their overflow. The
       z-index clears AppDialog's content (10001). */
    .projpick-list {
      position: fixed;
      z-index: 10002;
      max-height: 260px;
      overflow-y: auto;
      background: #FFFFFF;
      border: 1px solid rgba(46, 42, 38, 0.18);
      border-radius: 3px;
      box-shadow: 0 8px 18px rgba(46, 42, 38, 0.18);
      padding: 4px;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .projpick-option {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      padding: 7px 10px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 2px;
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 14px;
      color: #2E2A26;
      text-align: left;
      cursor: pointer;
      transition: background 100ms ease-out;
    }
    .projpick-option:hover,
    .projpick-option:focus-visible {
      background: rgba(154, 123, 53, 0.14);
      outline: none;
    }
    .projpick-option-selected {
      border-color: rgba(154, 123, 53, 0.48);
    }
    .projpick-option-active {
      background: rgba(154, 123, 53, 0.22);
    }
    .projpick-meta {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 10.5px;
      color: #7A7068;
      letter-spacing: 0.02em;
    }
    .projpick-add {
      padding: 7px 10px;
      margin-bottom: 2px;
      background: transparent;
      border: 1px solid transparent;
      border-bottom: 1px solid rgba(46, 42, 38, 0.12);
      border-radius: 2px 2px 0 0;
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 13.5px;
      color: rgba(154, 123, 53, 0.95);
      text-align: left;
      cursor: pointer;
      transition: background 100ms ease-out;
    }
    .projpick-add:hover,
    .projpick-add:focus-visible {
      background: rgba(154, 123, 53, 0.14);
      outline: none;
    }
    .projpick-empty {
      padding: 8px 10px;
      font-size: 12px;
      color: #7A7068;
      font-style: italic;
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
