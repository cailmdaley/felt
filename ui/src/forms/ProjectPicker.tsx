/**
 * ProjectPicker — the project combobox both forms use.
 *
 * Stash grew a filtering combobox while Capture kept a native `<select>`, and
 * the two drifted: only one of them could carry the "+ Add project…" row, since
 * a native `<select>` cannot host an option that acts as a button (a magic
 * `<option>` breaks keyboard selection and reads as a project you can pick).
 * This is that combobox extracted, so both forms get the same one.
 *
 * Two things it insists on:
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
 * Styles are injected once by element id, following `injectDirectoryPickerStyles`
 * — the same paper palette, so one component sits in Stash's sheet and
 * Capture's dialog without looking borrowed.
 */

import { useEffect, useRef, useState } from 'react'

export interface PickerProject {
  /** Stable key — `${originId}:${path}`. */
  id: string
  name?: string
  path: string
  /** `'local'` or a remote host name. */
  originId: string
}

export interface ProjectPickerProps {
  /** Already in the order the form wants them (recency, then name). */
  projects: PickerProject[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** The "Add a new project…" row's handler. Absent → no add row. */
  onAddProject?: () => void
  /** Field id, so a caller's `<label>` can point at the input. */
  inputId?: string
}

const ADD_LABEL = 'Add a new project…'

/** How a project reads in the closed field and in a row's title line. */
export function projectLabel(project: PickerProject): string {
  const name = project.name ?? project.id
  return project.originId === 'local' ? name : `${name} · ${project.originId}`
}

/** Case-insensitive match over name and origin — what the caller's old inline
 *  filters did, in one place. Exported for the unit test. */
export function filterProjects(projects: PickerProject[], query: string): PickerProject[] {
  const q = query.trim().toLowerCase()
  if (!q) return projects
  return projects.filter(
    (p) => (p.name ?? p.id).toLowerCase().includes(q) || p.originId.toLowerCase().includes(q),
  )
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
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const selected = projects.find((p) => p.id === selectedId) ?? null
  const filtered = filterProjects(projects, filter)
  // The row list the keyboard walks: the add row first, then the projects. One
  // array so ↑/↓ can't disagree with what is painted.
  const rows: Array<{ kind: 'add' } | { kind: 'project'; project: PickerProject }> = [
    ...(onAddProject ? [{ kind: 'add' as const }] : []),
    ...filtered.map((project) => ({ kind: 'project' as const, project })),
  ]

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close()
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
      {open && (
        <div className="projpick-list" role="listbox">
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
                <span className="projpick-meta">
                  {row.project.originId === 'local'
                    ? row.project.path
                    : `${row.project.originId} · ${row.project.path}`}
                </span>
              </button>
            ),
          )}
          {filtered.length === 0 && (
            <div className="projpick-empty">
              {filter.trim() ? `No project matches "${filter}".` : 'No projects registered yet.'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Inject the ProjectPicker's CSS once. Idempotent by element id, the same
 * pattern as `injectStashFormStyles` / `injectDirectoryPickerStyles`. Safe to
 * call from either form's mount path.
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
    .projpick-list {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      /* Above Capture's dialog chrome as well as Stash's sheet. */
      z-index: 60;
      max-height: 240px;
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
  `
  document.head.appendChild(style)
}
