import { useEffect, useRef, useState } from 'react'
import { filterParentCandidates, type FiberSearchResult } from '../board/fiberSearch'
import { fiberIndex } from '../board/wikilinks'

export type ParentIdMode = 'project-relative' | 'loom-relative'

interface ParentPickerProps {
  value: string
  onChange: (value: string) => void
  /** Loom-relative substore root; candidates are limited to this project. */
  scopePrefix: string
  shuttleBase: string
  /** Stash commits paths relative to the project; meetings commit loom ids. */
  idMode?: ParentIdMode
  inputClassName?: string
  placeholder?: string
}

/** Search within one project's subtree and return ids in the requested space. */
export function parentCandidates(
  all: Array<{ id: string; name: string }>,
  query: string,
  scopePrefix: string,
  idMode: ParentIdMode = 'project-relative',
): FiberSearchResult[] {
  const scoped = scopePrefix
    ? all.filter((fiber) => fiber.id === scopePrefix || fiber.id.startsWith(`${scopePrefix}/`))
    : all
  const relative = scoped
    .filter((fiber) => !scopePrefix || fiber.id !== scopePrefix)
    .map((fiber) => ({
      id: scopePrefix ? fiber.id.slice(scopePrefix.length + 1) : fiber.id,
      name: fiber.name,
    }))
    .filter((fiber) => fiber.id)
  const trimmedQuery = query.trim()
  const localQuery = idMode === 'loom-relative' && scopePrefix
    ? trimmedQuery === scopePrefix
      ? ''
      : trimmedQuery.startsWith(`${scopePrefix}/`)
        ? trimmedQuery.slice(scopePrefix.length + 1)
        : trimmedQuery
    : trimmedQuery
  const children = filterParentCandidates(relative, localQuery, '').map((fiber) => ({
    ...fiber,
    id: idMode === 'loom-relative' && scopePrefix
      ? `${scopePrefix}/${fiber.id}`
      : fiber.id,
  }))

  if (idMode !== 'loom-relative' || !scopePrefix) return children
  const root = all.find((fiber) => fiber.id === scopePrefix)
  const q = localQuery.toLowerCase()
  const rootMatches = root && (
    !q || root.name.toLowerCase().includes(q) || root.id.toLowerCase().includes(trimmedQuery.toLowerCase())
  )
  return rootMatches && root
    ? [{ id: root.id, name: root.name, depth: 0 }, ...children]
    : children
}

export function ParentPicker({
  value,
  onChange,
  scopePrefix,
  shuttleBase,
  idMode = 'project-relative',
  inputClassName = 'stash-input',
  placeholder = 'standalone-kanban  ·  backend/…',
}: ParentPickerProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState<FiberSearchResult[]>([])
  const [highlight, setHighlight] = useState(-1)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const debounceRef = useRef<number | null>(null)

  const fetchResults = (query: string): void => {
    fiberIndex(shuttleBase)
      .then((all) => {
        setResults(parentCandidates(all, query, scopePrefix, idMode))
        setHighlight(-1)
        setOpen(true)
      })
      .catch(() => {})
  }

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [open])

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const next = e.target.value
    onChange(next)
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => fetchResults(next.trim()), 200)
  }

  const commit = (result: FiberSearchResult): void => {
    onChange(result.id)
    setOpen(false)
    inputRef.current?.blur()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) {
        fetchResults(value.trim())
        return
      }
      setHighlight((current) => Math.min(results.length - 1, current + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((current) => Math.max(-1, current - 1))
    } else if (e.key === 'Enter' && open && highlight >= 0 && results[highlight]) {
      e.preventDefault()
      commit(results[highlight])
    } else if (e.key === 'Escape' && open) {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <div className="parent-picker" ref={wrapRef}>
      <input
        ref={inputRef}
        type="text"
        className={inputClassName}
        value={value}
        onChange={handleInput}
        onFocus={() => fetchResults(value.trim())}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
      />
      {open && (
        <div className="parent-dropdown" role="listbox">
          {results.length === 0 ? (
            <div className="parent-option parent-empty">
              {value.trim() ? 'No matches' : 'No fibers in this project'}
            </div>
          ) : (
            results.map((result, index) => (
              <button
                key={result.id}
                type="button"
                className={`parent-option${index === highlight ? ' parent-option-active' : ''}`}
                data-depth={result.depth}
                onMouseDown={(e) => {
                  e.preventDefault()
                  commit(result)
                }}
                onMouseEnter={() => setHighlight(index)}
              >
                <span className="parent-option-name">{result.name}</span>
                <span className="parent-option-id">{result.id}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

/** Shared candidate-list styling for Stash and Meeting. */
export function injectParentPickerStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('parent-picker-styles')) return
  const style = document.createElement('style')
  style.id = 'parent-picker-styles'
  style.textContent = `
    .parent-picker { position: relative; }
    .parent-dropdown {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      z-index: 10;
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
    .parent-option {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      padding: 6px 10px;
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
    .parent-option:hover,
    .parent-option-active {
      background: rgba(154, 123, 53, 0.18);
      border-color: rgba(154, 123, 53, 0.40);
    }
    .parent-option-name { font-weight: 500; color: #2E2A26; }
    .parent-option-id {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 10.5px;
      letter-spacing: 0.02em;
      color: #7A7068;
    }
    .parent-option[data-depth="1"] .parent-option-name { font-weight: 600; }
    .parent-empty {
      padding: 8px 10px;
      font-size: 12px;
      color: #7A7068;
      font-style: italic;
      cursor: default;
    }
  `
  document.head.appendChild(style)
}
