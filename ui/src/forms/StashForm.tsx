/**
 * StashForm — file a constitution (a shuttle-block fiber) directly.
 *
 * A `+` button in the kanban header opens this form; the user types a title
 * (and optionally body, tags, parent), chooses dispatch settings, and on save
 * it POSTs Shuttle's own `POST /api/v1/fiber/create`. No agent in the loop —
 * stash just files + installs the shuttle block; dispatch is the kanban's job.
 * Every stash is a constitution: a oneshot lands in Drafts (`status: open`,
 * promote to dispatch via the board) or a standing role arrives armed and
 * scheduled (`status: active`).
 *
 * ── Building the id client-side ─────────────────────────────────────────────
 * Shuttle's endpoint expects `{id, name, frontmatter:{shuttle:{…}}}` with a
 * pre-computed id and pre-built block, and it derives its felt root from
 * `shuttle.project_dir`. Because a project's `.felt` is a loom *substore*
 * symlink (`…/<project>/.felt → loom/.felt/<…>/<project>`), `felt -C
 * <project_dir> add <id> --top-level` expects `id` *relative to that substore*.
 * So this form speaks project-relative ids natively: the parent picker is
 * scoped to the selected project and strips its `loomPrefix`, and `submit`
 * builds `{id, name, body, frontmatter, origin}` itself. Create is owner-routed
 * on the daemon, so the island offers every project — the selected project's
 * `origin` rides the POST: a local origin writes here, a remote origin forwards
 * to its owning daemon (which auto-stamps its own `shuttle.host`).
 *
 * Capture's sibling: the same AppDialog card and the same formKit column —
 * lead field, the host · project · agent · effort row, session and `--chrome`,
 * the footer — with Stash's own parts (slug receipt, tags, parent picker, kind
 * segments, schedule) slotted into that rhythm. Esc closes (Radix);
 * Cmd/Ctrl+Enter submits.
 */

import { useEffect, useRef, useState } from 'react'
import { agentGroups, resolveEffort, useAgentRegistry } from './agents'
import { AppDialog } from './AppDialog'
import { injectStyles } from './injectStyles'
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
import { filterParentCandidates, type FiberSearchResult } from '../board/fiberSearch'
import { fiberIndex } from '../board/wikilinks'
import { daemonErrorMessage } from '../board/daemonApi'
import type { Host, Project } from './projectModel'
import { defaultSurface, isCodexAgent, type ExecutionSurface } from './executionSurface'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StashFormProps {
  /** Every project, in picker order, on every host (create is owner-routed). */
  projects: Project[]
  /** Every host the picker can point at — the store registry's origins. The
   *  host control is the left half of the pair; the project list is whatever
   *  the selected host owns. */
  hosts: Host[]
  /** Existing tag set for autocomplete (island-supplied, from the feed). */
  tagSuggestions?: string[]
  /** Shuttle daemon base. Defaults to `''` (relative / same-origin). */
  shuttleBase?: string
  /** Called after a successful save with the new fiber id. */
  onCreated: (fiberId: string) => void
  /** Register a new project directory and hand back the refreshed project set
   *  (the island re-derives it from the daemon). Absent → the picker offers no
   *  "+ Add project…" row. */
  onProjectAdded?: (path: string) => Promise<Project[]>
  /** Called on Esc / cancel / overlay click. */
  onCancel: () => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The slug rule — mirrors Shuttle/felt's (kebab-case, lowercased, non-alphanum
 * collapsed, leading/trailing hyphens stripped, capped at 60). The single
 * source for both the live preview and the submitted id, so preview == reality
 * by construction. Empty stem means the title had no alphanumerics; each caller
 * labels that case for itself.
 */
function slugStem(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/** The shuttle block, assembled client-side (lean: only true/non-empty
 *  fields ride). */
function buildShuttleBlock(input: {
  agent: string
  effort: string
  kind: 'oneshot' | 'standing'
  schedule: string
  tz: string
  projectDir: string
  chrome: boolean
  surface: ExecutionSurface
}): Record<string, unknown> {
  const block: Record<string, unknown> = {
    kind: input.kind,
    project_dir: input.projectDir,
  }
  if (input.agent) block.agent = input.agent
  if (input.effort.trim()) block.effort = input.effort.trim()
  if (input.chrome) block.chrome = true
  if (input.surface !== 'cli') block.surface = input.surface
  if (input.kind === 'standing') {
    block.schedule = { expr: input.schedule.trim(), tz: input.tz.trim() || 'UTC' }
  }
  return block
}

/**
 * Validate a parent-fiber slug (project-relative). Felt slugs are kebab-case
 * ASCII with optional `/`-separated nesting. They are NOT filesystem paths —
 * leading `~`/`/`/`.`, `..`, and other path-shaped characters would embed as
 * literal directory names. Returns null when well-formed, else a message.
 */
function validateParentSlug(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null // empty = top-level, perfectly fine
  if (s.startsWith('~') || s.startsWith('/') || s.startsWith('.')) {
    return 'Parent is a fiber slug (e.g. shuttle), not a filesystem path.'
  }
  if (s.includes('..')) {
    return 'Parent slug cannot contain `..`.'
  }
  if (!/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(s)) {
    return 'Parent slug must be kebab-case (lowercase letters, digits, hyphens, optional `/` for nesting).'
  }
  return null
}

const KIND_SEGMENTS = [
  ['oneshot', 'One-shot', 'lands in Drafts'],
  ['standing', 'Standing', 'on a schedule'],
] as const

// ---------------------------------------------------------------------------
// Parent-fiber picker — project-scoped, project-relative
// ---------------------------------------------------------------------------

interface ParentPickerProps {
  value: string
  onChange: (value: string) => void
  /** The selected project's loomPrefix — candidates are scoped to this subtree
   *  and shown/committed project-relative. `''` = the project is a store root. */
  scopePrefix: string
  shuttleBase: string
}

function ParentPicker({ value, onChange, scopePrefix, shuttleBase }: ParentPickerProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState<FiberSearchResult[]>([])
  const [highlight, setHighlight] = useState(-1)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const debounceRef = useRef<number | null>(null)

  // Scope the daemon's (loom-relative) index to the selected project, then
  // strip the loomPrefix so candidates are project-relative — exactly the id
  // space the create endpoint expects for this project_dir.
  const fetchResults = (query: string): void => {
    fiberIndex(shuttleBase)
      .then((all) => {
        const scoped = scopePrefix
          ? all
              .filter((f) => f.id === scopePrefix || f.id.startsWith(scopePrefix + '/'))
              .map((f) => ({ id: f.id.slice(scopePrefix.length).replace(/^\//, ''), name: f.name }))
              .filter((f) => f.id) // drop the project-root fiber itself (id → '')
          : all
        setResults(filterParentCandidates(scoped, query, ''))
        setHighlight(-1)
        setOpen(true)
      })
      .catch(() => {})
  }

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [open])

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const v = e.target.value
    onChange(v)
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => fetchResults(v.trim()), 200)
  }

  const commit = (r: FiberSearchResult): void => {
    onChange(r.id)
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
      setHighlight((h) => Math.min(results.length - 1, h + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(-1, h - 1))
    } else if (e.key === 'Enter') {
      if (open && highlight >= 0 && results[highlight]) {
        e.preventDefault()
        commit(results[highlight])
      }
    } else if (e.key === 'Escape') {
      // The dialog leaves Escape to an expanded combobox (see AppDialog), so
      // this closes only the dropdown.
      if (open) setOpen(false)
    }
  }

  return (
    <div className="stash-parent-picker" ref={wrapRef}>
      <input
        ref={inputRef}
        type="text"
        className="form-input"
        value={value}
        onChange={handleInput}
        onFocus={() => fetchResults(value.trim())}
        onKeyDown={handleKeyDown}
        placeholder="standalone-kanban  ·  backend/…"
        autoComplete="off"
        aria-label="Parent fiber"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
      />
      {open && (
        <div className="stash-parent-dropdown" role="listbox">
          {results.length === 0 ? (
            <div className="stash-parent-option stash-parent-empty">
              {value.trim() ? 'No matches' : 'No fibers in this project'}
            </div>
          ) : (
            results.map((r, i) => (
              <button
                key={r.id}
                type="button"
                className={`stash-parent-option${i === highlight ? ' stash-parent-option-active' : ''}`}
                data-depth={r.depth}
                onMouseDown={(e) => {
                  e.preventDefault()
                  commit(r)
                }}
                onMouseEnter={() => setHighlight(i)}
              >
                <span className="stash-parent-option-name">{r.name}</span>
                <span className="stash-parent-option-id">{r.id}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StashForm({
  projects: availableProjects,
  hosts,
  tagSuggestions = [],
  shuttleBase = '',
  onCreated,
  onProjectAdded,
  onCancel,
}: StashFormProps): JSX.Element {
  // Core stash fields
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [parentSlug, setParentSlug] = useState<string>('')

  // Dispatch fields (shuttle)
  const registry = useAgentRegistry(shuttleBase)
  const agents = registry ?? []
  const [agentId, setAgentId] = useState<string>('') // '' = registry default
  const [effort, setEffort] = useState<string>('')
  const [kind, setKind] = useState<'oneshot' | 'standing'>('oneshot')
  const [schedule, setSchedule] = useState<string>('')
  const [scheduleTz, setScheduleTz] = useState<string>('Europe/Paris')
  const [chrome, setChrome] = useState<boolean>(false)
  const [surface, setSurface] = useState<ExecutionSurface>('cli')

  // Form state
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  const titleRef = useRef<HTMLInputElement | null>(null)

  // Autofocus the title on first paint.
  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  // The agent registry straight from the daemon. Best-effort: absence or a
  // malformed body degrades to a free-text agent input. Once it lands, the
  // select starts on the registry's default agent.
  useEffect(() => {
    const def = registry?.find((a) => a.default)
    if (def) setAgentId(def.id)
  }, [registry])

  const tagInputLower = tagInput.trim().toLowerCase()
  const filteredSuggestions = tagSuggestions
    .filter((t) => !tags.includes(t) && (!tagInputLower || t.toLowerCase().includes(tagInputLower)))
    .slice(0, 8)

  const addTag = (raw: string): void => {
    const t = raw.trim()
    if (!t) return
    if (tags.includes(t)) return
    setTags([...tags, t])
    setTagInput('')
  }

  const removeTag = (t: string): void => {
    setTags(tags.filter((x) => x !== t))
  }

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addTag(tagInput)
    } else if (e.key === 'Backspace' && tagInput === '' && tags.length > 0) {
      removeTag(tags[tags.length - 1])
    }
  }

  const submit = async (): Promise<void> => {
    if (submitting) return
    const trimmedTitle = title.trim()
    if (!trimmedTitle) {
      setError('Title is required')
      titleRef.current?.focus()
      return
    }
    const parentError = validateParentSlug(parentSlug)
    if (parentError) {
      setError(parentError)
      return
    }
    if (kind === 'standing' && !schedule.trim()) {
      setError('Schedule (cron expression) is required for standing roles.')
      return
    }
    if (!selectedProject) {
      setError('Pick a project — the stash needs a felt store to land in.')
      return
    }

    setSubmitting(true)
    setError(null)

    // ── Translation layer ──────────────────────────────────────────────────
    // Build the project-relative id + native frontmatter, then POST Shuttle's
    // own create shape. `parentSlug` is already project-relative (the picker is
    // scoped to this project), so the id derivation is the plain join.
    const childSlug = slugStem(trimmedTitle) || `stash-${Date.now()}`
    const parentRel = parentSlug.trim().replace(/^\/+|\/+$/g, '')
    const id = parentRel ? `${parentRel}/${childSlug}` : childSlug

    const frontmatter: Record<string, unknown> = {
      name: trimmedTitle,
      status: kind === 'standing' ? 'active' : 'open',
      ...(tags.length > 0 ? { tags: [...tags] } : {}),
      shuttle: buildShuttleBlock({
        agent: agentId,
        effort: effectiveEffort,
        kind,
        schedule,
        tz: scheduleTz,
        projectDir: selectedProject.path,
        chrome: chrome && chromeCapable,
        surface,
      }),
    }

    try {
      const res = await fetch(`${shuttleBase}/api/v1/fiber/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          name: trimmedTitle,
          body,
          frontmatter,
          // Owner-routing key — the daemon writes locally when this is its own
          // origin (or 'local') and forwards to the owning remote otherwise.
          origin: selectedProject.originId,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string }
      if (!res.ok || !data.id) {
        throw new Error(data.error || `Server returned ${res.status}`)
      }
      onCreated(data.id)
    } catch (err) {
      setError(daemonErrorMessage(err))
      setSubmitting(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void submit()
    }
  }

  const defaultAgentEntry = agents.find((a) => a.default)
  const defaultAgentLabel = defaultAgentEntry?.id ?? 'default'
  const parentValidation = validateParentSlug(parentSlug)

  // The agent whose constraint metadata gates the dependent axes.
  const constraintAgent = agents.find((a) => a.id === agentId) ?? defaultAgentEntry
  const effectiveEffort = resolveEffort(constraintAgent, effort)
  const chromeCapable = selectedHost.browserCapable && constraintAgent?.chrome_capable === true

  useEffect(() => {
    if (chrome && !chromeCapable) setChrome(false)
  }, [chrome, chromeCapable])

  const handleStashHostChange = (id: string): void => {
    setChrome(false)
    handleHostChange(id)
  }

  const handleAgentChange = (id: string): void => {
    const wasCodex = isCodexAgent(agents.find((a) => a.id === agentId) ?? defaultAgentEntry)
    setAgentId(id)
    const rec = agents.find((a) => a.id === id) ?? agents.find((a) => a.default)
    setEffort(resolveEffort(rec, ''))
    if (!wasCodex) setSurface(defaultSurface(rec))
  }

  return (
    <AppDialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
      title="Stash a constitution"
      eyebrow="shuttle · stash"
    >
      <div className="form-sheet" onKeyDown={handleKeyDown}>
        <Field label="Title">
          <input
            ref={titleRef}
            type="text"
            className="form-input stash-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Look into garden lens"
            required
            maxLength={200}
          />
          {title.trim() && (
            <span className="stash-receipt">
              <span className="stash-receipt-key">slug</span>
              <span className="stash-receipt-sep">›</span>
              <code className="stash-receipt-val">
                {parentSlug ? `${parentSlug}/` : ''}{slugStem(title) || 'stash-…'}
              </code>
            </span>
          )}
        </Field>
        <Field label="Body" optional>
          <textarea
            className="form-textarea"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Free-form — paragraphs, code, whatever. Skip it if the title is enough."
            rows={3}
          />
        </Field>
        <Field label="Tags" optional as="div">
          <div className="stash-chips">
            {tags.map((t) => (
              <span key={t} className="stash-chip">
                {t}
                <button
                  type="button"
                  className="stash-chip-x"
                  onClick={() => removeTag(t)}
                  aria-label={`Remove tag ${t}`}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              type="text"
              className="stash-tag-input"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={handleTagKeyDown}
              placeholder={tags.length === 0 ? 'tag, then Enter' : ''}
            />
          </div>
          {filteredSuggestions.length > 0 && tagInput && (
            <div className="stash-suggestions" role="listbox">
              {filteredSuggestions.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="stash-suggestion"
                  onClick={() => addTag(t)}
                  role="option"
                  aria-selected="false"
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </Field>
        <div className="form-controls">
          {/* Rendered even with no projects, as long as there is a way to add
              one: the project select's "Add a new project…" entry is how a
              host with an empty list bootstraps its first. */}
          {(projects.length > 0 || onProjectAdded) && (
            <HostProjectFields
              hosts={hosts}
              selectedHostId={selectedHostId}
              onHostChange={handleStashHostChange}
              projects={hostProjects}
              selectedProjectId={selectedProjectId}
              onProjectChange={setSelectedProjectId}
              onAddProject={onProjectAdded ? addProject.begin : undefined}
            />
          )}
          <Field label="Agent">
            {agents.length > 0 ? (
              <select
                className="form-select"
                value={agentId}
                onChange={(e) => handleAgentChange(e.target.value)}
              >
                <option value="">Default ({defaultAgentLabel})</option>
                {agentGroups(agents).map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.id}{a.default ? ' (default)' : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            ) : (
              <input
                type="text"
                className="form-input"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                placeholder="Registry default"
              />
            )}
          </Field>
          <EffortField agent={constraintAgent} effort={effort} onChange={setEffort} />
          <Field label="Parent fiber" optional as="div" className="form-span-2">
            <ParentPicker
              value={parentSlug}
              onChange={setParentSlug}
              scopePrefix={selectedProject?.loomPrefix ?? ''}
              shuttleBase={shuttleBase}
            />
          </Field>
          <Field label="Kind" as="div" className="form-span-2">
            <div className="stash-segmented" role="radiogroup" aria-label="Dispatch kind">
              {KIND_SEGMENTS.map(([value, name, hint]) => (
                <label
                  key={value}
                  className={kind === value ? 'stash-segment stash-segment-active' : 'stash-segment'}
                >
                  <input
                    type="radio"
                    name="stash-kind"
                    value={value}
                    checked={kind === value}
                    onChange={() => setKind(value)}
                  />
                  <span className="stash-segment-name">{name}</span>
                  <span className="stash-segment-hint">{hint}</span>
                </label>
              ))}
            </div>
          </Field>
          {kind === 'standing' && (
            <>
              <Field label="Schedule" className="form-span-2">
                <input
                  type="text"
                  className="form-input form-mono"
                  value={schedule}
                  onChange={(e) => setSchedule(e.target.value)}
                  placeholder="0 9 * * 1-5"
                  required
                />
                <span className="form-hint">
                  5-field cron · e.g. <code>0 9 * * 1-5</code> (weekdays 09:00)
                </span>
              </Field>
              <Field label="Timezone" className="form-span-2">
                <input
                  type="text"
                  className="form-input"
                  value={scheduleTz}
                  onChange={(e) => setScheduleTz(e.target.value)}
                  placeholder="Europe/Paris"
                />
                <span className="form-hint">IANA name</span>
              </Field>
            </>
          )}
          {isCodexAgent(constraintAgent) && (
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
        {parentValidation && <div className="form-hint form-hint-warn">{parentValidation}</div>}
        <ChromeFlag checked={chrome} capable={chromeCapable} onChange={setChrome} />
        <FormError error={error} />
        <FormFoot
          verb="stash"
          submitLabel={submitting ? 'Stashing…' : 'Stash'}
          submitting={submitting}
          disabled={submitting || !title.trim()}
          tone="brass"
          onCancel={onCancel}
          onSubmit={() => void submit()}
        />
      </div>
    </AppDialog>
  )
}

/**
 * Inject the Stash dialog's CSS: the shared form sheet, plus the parts only
 * Stash has — the slug receipt, tag chips, the parent dropdown and the kind
 * segments.
 */
export function injectStashFormStyles(): void {
  injectFormKitStyles()
  injectStyles('stash-form-styles', `
    /* The title is Stash's lead field, as the yap is Capture's: 17px. */
    .stash-title {
      font-size: 17px;
      padding: 8px 11px;
    }
    .stash-receipt {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      align-self: flex-start;
      padding: 2px 8px;
      background: rgba(255, 252, 245, 0.7);
      border: 1px dashed rgba(154, 123, 53, 0.42);
      border-radius: 2px;
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 11px;
      color: #5C544D;
    }
    .stash-receipt-key {
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: #C49333;
      font-size: 9.5px;
    }
    .stash-receipt-sep {
      color: #B5A998;
    }
    .stash-receipt-val {
      font-family: inherit;
      color: #2E2A26;
    }
    .stash-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      box-sizing: border-box;
      padding: 5px 8px;
      background: #FFFFFF;
      border: 1px solid rgba(46, 42, 38, 0.20);
      border-radius: 3px;
      min-height: 36px;
    }
    .stash-chips:focus-within {
      border-color: #C49333;
      box-shadow: 0 0 0 2px rgba(154, 123, 53, 0.18);
    }
    .stash-chip {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 2px 4px 2px 8px;
      background: rgba(154, 123, 53, 0.14);
      border: 1px solid rgba(154, 123, 53, 0.32);
      border-radius: 12px;
      font-size: 12px;
      color: #5A4520;
    }
    .stash-chip-x {
      background: transparent;
      border: 0;
      color: #5A4520;
      cursor: pointer;
      font-size: 14px;
      padding: 0 4px;
      line-height: 1;
      border-radius: 50%;
    }
    .stash-chip-x:hover {
      background: rgba(178, 78, 60, 0.18);
      color: #8B3A28;
    }
    .stash-tag-input {
      flex: 1;
      min-width: 100px;
      border: 0;
      outline: none;
      padding: 2px 4px;
      background: transparent;
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 15px;
      color: #2E2A26;
    }
    .stash-tag-input::placeholder {
      color: #9A8E80;
      font-style: italic;
    }
    .stash-suggestions {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .stash-suggestion {
      background: rgba(46, 42, 38, 0.05);
      border: 1px solid rgba(46, 42, 38, 0.14);
      color: #2E2A26;
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 12px;
      padding: 2px 8px;
      border-radius: 10px;
      cursor: pointer;
      transition: background 100ms ease-out;
    }
    .stash-suggestion:hover {
      background: rgba(154, 123, 53, 0.18);
      border-color: rgba(154, 123, 53, 0.42);
    }
    .stash-parent-picker {
      position: relative;
    }
    .stash-parent-dropdown {
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
    .stash-parent-option {
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
    .stash-parent-option:hover,
    .stash-parent-option-active {
      background: rgba(154, 123, 53, 0.18);
      border-color: rgba(154, 123, 53, 0.40);
    }
    .stash-parent-option-name {
      font-weight: 500;
      color: #2E2A26;
    }
    .stash-parent-option-id {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 10.5px;
      letter-spacing: 0.02em;
      color: #7A7068;
    }
    .stash-parent-option[data-depth="1"] .stash-parent-option-name {
      font-weight: 600;
    }
    .stash-parent-empty {
      padding: 8px 10px;
      font-size: 12px;
      color: #7A7068;
      font-style: italic;
      cursor: default;
    }
    /* Two segments in one box the height of a select, so the kind sits on the
       control row's baseline beside the parent picker. */
    .stash-segmented {
      box-sizing: border-box;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 2px;
      height: 36px;
      padding: 2px;
      background: rgba(46, 42, 38, 0.035);
      border: 1px solid rgba(46, 42, 38, 0.20);
      border-radius: 3px;
    }
    .stash-segmented:focus-within {
      border-color: #C49333;
      box-shadow: 0 0 0 2px rgba(154, 123, 53, 0.18);
    }
    .stash-segment {
      display: flex;
      align-items: baseline;
      gap: 7px;
      padding: 0 10px;
      line-height: 30px;
      border-radius: 2px;
      cursor: pointer;
      color: #7A7068;
      min-width: 0;
      overflow: hidden;
      transition: background 120ms ease-out, color 120ms ease-out;
    }
    .stash-segment input[type="radio"] {
      position: absolute;
      opacity: 0;
      pointer-events: none;
      width: 0;
      height: 0;
    }
    .stash-segment-name {
      font-size: 15px;
      flex: none;
    }
    .stash-segment-hint {
      font-size: 12px;
      font-style: italic;
      color: #9A8E80;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .stash-segment:hover:not(.stash-segment-active) {
      color: #2E2A26;
    }
    .stash-segment-active {
      color: #2E2A26;
      background: #FFFFFF;
      box-shadow: 0 0 0 1px rgba(46, 42, 38, 0.12), 0 1px 2px rgba(46, 42, 38, 0.10);
      cursor: default;
    }
  `)
}
