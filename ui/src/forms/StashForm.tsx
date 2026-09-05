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
 * Esc closes; Cmd/Ctrl+Enter submits.
 */

import { useEffect, useRef, useState } from 'react'
import {
  AddProjectPath,
  HostPicker,
  ProjectPicker,
  FALLBACK_HOST,
  byRecency,
  injectProjectPickerStyles,
  projectsForHost,
  type PickerHost,
} from './ProjectPicker'
import { useAddProject } from './useAddProject'
import { filterParentCandidates, type FiberSearchResult } from '../board/fiberSearch'
import { fiberIndex } from '../board/wikilinks'
import { shuttleOrigin } from './projectModel'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentEntry {
  id: string
  model?: string
  default: boolean
  /** Harness-native effort tokens this agent accepts; empty/absent = no effort axis. */
  effort_levels?: string[]
  /** Concrete token applied when the fiber omits an explicit effort. */
  default_effort?: string | null
  /** Whether the harness supports `--chrome` (claude only). */
  chrome_capable?: boolean
  /** Alias records resolve to base + axes; the composing picker supersedes them. */
  alias_of?: string | null
}

/** A destination project, derived by the island from the composite feed. */
export interface StashProject {
  id: string
  name?: string
  /** `shuttle.project_dir` — the worker cwd AND the create endpoint's felt root. */
  path: string
  /** Owner-routing key sent as `origin`: `'local'` for the local daemon's own
   *  projects, else the owning remote's bare name (e.g. `cluster-a`). */
  originId: string
  /** Loom-relative substore prefix; `''` when the project is a store root.
   *  Used to scope/strip parent candidates to project-relative slugs. */
  loomPrefix: string
}

export interface StashFormProps {
  /** Connected projects (the island supplies the local-only set for create). */
  availableCities?: StashProject[]
  /** Every host the picker can point at — the store registry's origins. The
   *  host control is the left half of the pair; the project list is whatever
   *  the selected host owns. */
  availableHosts?: PickerHost[]
  /** Optional activity timestamps per project id, for the recency sort. */
  cityActivityById?: Record<string, number>
  /** Existing tag set for autocomplete (island-supplied, from the feed). */
  tagSuggestions?: string[]
  /** Shuttle daemon base. Defaults to `''` (relative / same-origin). */
  shuttleBase?: string
  /** Called after a successful save with the new fiber id. */
  onCreated: (fiberId: string) => void
  /** Register a new project directory and hand back the refreshed project set
   *  (the island re-derives it from the daemon). Absent → the picker offers no
   *  "+ Add project…" row. */
  onProjectAdded?: (path: string) => Promise<StashProject[]>
  /** Called on Esc / cancel / backdrop click. */
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
}): Record<string, unknown> {
  const block: Record<string, unknown> = {
    kind: input.kind === 'standing' ? 'standing' : 'oneshot',
    project_dir: input.projectDir,
  }
  if (input.agent) block.agent = input.agent
  if (input.effort.trim()) block.effort = input.effort.trim()
  if (input.chrome) block.chrome = true
  if (block.kind === 'standing') {
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
  ['oneshot', 'One-shot', 'drafts, manual launch'],
  ['standing', 'Standing', 'cron-scheduled role'],
] as const

/** Human-readable label for an agent entry. */
function agentLabel(a: AgentEntry): string {
  return a.model ? `${a.id} · ${a.model}` : a.id
}

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
      if (open) {
        // Consume Escape so it dismisses only the dropdown — without
        // stopPropagation it bubbles to the dialog's handler and closes the
        // whole form.
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
      }
    }
  }

  return (
    <div className="stash-parent-picker" ref={wrapRef}>
      <input
        ref={inputRef}
        type="text"
        className="stash-input"
        value={value}
        onChange={handleInput}
        onFocus={() => fetchResults(value.trim())}
        onKeyDown={handleKeyDown}
        placeholder="standalone-kanban  ·  backend/…"
        autoComplete="off"
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
  availableCities = [],
  availableHosts = [],
  cityActivityById = {},
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
  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [agentId, setAgentId] = useState<string>('') // '' = registry default
  const [effort, setEffort] = useState<string>('')
  const [kind, setKind] = useState<'oneshot' | 'standing'>('oneshot')
  const [schedule, setSchedule] = useState<string>('')
  const [scheduleTz, setScheduleTz] = useState<string>('Europe/Paris')
  const [chrome, setChrome] = useState<boolean>(false)

  // Form state
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Host, then project. The host defaults to the local daemon's own unless the
  // caller scoped the form to a project living elsewhere: ranking hosts by
  // recency would point a fresh form at whichever remote was busiest, and "+
  // Add project…" would then mean "on that remote", which is the confusion the
  // split exists to remove.
  const hosts: PickerHost[] = availableHosts.length > 0 ? availableHosts : [FALLBACK_HOST]
  const defaultHostId = hosts.find((h) => h.isLocal)?.id ?? hosts[0].id
  const [selectedHostId, setSelectedHostId] = useState<string>(defaultHostId)

  // Project default within that host: most-recently-active → first
  // alphabetically → null (only when empty).
  const [selectedCityId, setSelectedCityId] = useState<string | null>(
    () => projectsForHost(availableCities, defaultHostId).sort(byRecency(cityActivityById))[0]?.id ?? null,
  )
  // The live project set: seeded from the island's derivation, then replaced
  // wholesale when "+ Add project…" registers a directory (the island re-derives
  // through `deriveProjects`, so shape stays single-sourced there).
  const [cities, setCities] = useState<StashProject[]>(availableCities)

  const titleRef = useRef<HTMLInputElement | null>(null)

  // Autofocus the title on first paint.
  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  // The agent registry straight from the daemon — a bare array. Best-effort:
  // absence or a malformed body degrades to a free-text agent input.
  useEffect(() => {
    let cancelled = false
    fetch(`${shuttleBase}/api/v1/agents`)
      .then((res) => (res.ok ? res.json() : null))
      .then((raw: AgentEntry[] | null) => {
        if (cancelled || !Array.isArray(raw)) return
        const list = raw.filter((a) => !a.alias_of)
        if (!list.length) return
        setAgents(list)
        const def = list.find((a) => a.default)
        if (def) setAgentId(def.id)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [shuttleBase])

  const sortedCities = [...cities].sort(byRecency(cityActivityById))
  const hostCities = projectsForHost(sortedCities, selectedHostId)
  const selectedHost = hosts.find((h) => h.id === selectedHostId) ?? hosts[0]
  const selectedCity = hostCities.find((c) => c.id === selectedCityId) ?? null

  // "+ Add project…" — native OS dialog on a local host that has one, the
  // absolute-path row everywhere else (see useAddProject).
  const addProject = useAddProject<StashProject>({
    shuttleBase,
    nativeFolderPicker: selectedHost.isLocal && selectedHost.nativeFolderPicker,
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
  // selection belonging to the previous host would create on the wrong machine,
  // and null would silently block submit. Any open path row belongs to the old
  // host, so it goes too.
  const handleHostChange = (id: string): void => {
    setSelectedHostId(id)
    setSelectedCityId(projectsForHost(sortedCities, id)[0]?.id ?? null)
    addProject.closePath()
  }

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
    if (!selectedCity) {
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
        projectDir: selectedCity.path,
        chrome,
      }),
    }

    try {
      const res = await fetch(`${shuttleBase}/api/v1/fiber/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          name: trimmedTitle,
          body: body.length > 0 ? body : '',
          frontmatter,
          // Owner-routing key — the daemon writes locally when this is its own
          // origin (or 'local') and forwards to the owning remote otherwise.
          origin: shuttleOrigin(selectedCity.originId),
        }),
      })
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string }
      if (!res.ok || !data.id) {
        throw new Error(data.error || `Server returned ${res.status}`)
      }
      onCreated(data.id)
    } catch (err) {
      const msg = (err as { message?: string })?.message ?? String(err)
      setError(msg.includes('fetch') ? 'Couldn’t reach the Shuttle daemon (:4000).' : msg)
      setSubmitting(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void submit()
    }
  }

  const defaultAgentEntry = agents.find((a) => a.default)
  const defaultAgentLabel = defaultAgentEntry ? agentLabel(defaultAgentEntry) : 'default'
  const parentValidation = validateParentSlug(parentSlug)

  // The agent whose constraint metadata gates the dependent axes.
  const constraintAgent = agents.find((a) => a.id === agentId) ?? defaultAgentEntry
  const effortLevels = constraintAgent?.effort_levels ?? []
  const effectiveEffort = effortLevels.includes(effort)
    ? effort
    : constraintAgent?.default_effort && effortLevels.includes(constraintAgent.default_effort)
      ? constraintAgent.default_effort
      : ''
  const chromeCapable = agents.length === 0 ? true : constraintAgent?.chrome_capable ?? false

  // Clamp axes whenever the constraint agent shifts under them.
  useEffect(() => {
    if (effort !== effectiveEffort) setEffort(effectiveEffort)
    if (chrome && !chromeCapable) setChrome(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [constraintAgent?.id, agents])

  const handleAgentChange = (id: string): void => {
    setAgentId(id)
    const rec = agents.find((a) => a.id === id) ?? agents.find((a) => a.default)
    const levels = rec?.effort_levels ?? []
    setEffort(rec?.default_effort && levels.includes(rec.default_effort) ? rec.default_effort : '')
    if (!(rec?.chrome_capable ?? false)) setChrome(false)
  }

  return (
    <div
      className="stash-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
      onKeyDown={handleKeyDown}
    >
      <div
        className="stash-card"
        role="dialog"
        aria-modal="true"
        aria-label="Stash a new fiber"
      >
        <div className="stash-header">
          <div className="stash-header-row">
            <h2 className="stash-title">Stash a constitution</h2>
            <span className="stash-eyebrow">shuttle · kanban</span>
          </div>
          <div className="stash-subtitle">
            Drop an idea. Lands in Drafts — promote to dispatch via the kanban.
          </div>
          <span className="stash-header-rule" aria-hidden="true" />
        </div>

        <div className="stash-body">
          {/* ── Section: WHERE — project + parent fiber ── */}
          <section className="stash-section">
            <div className="stash-section-head">
              <span className="stash-section-label">Where</span>
              <span className="stash-section-rule" aria-hidden="true" />
            </div>
            <div className="stash-row stash-row-3">
              {/* Host, then project */}
              {/* Rendered even with no projects, as long as there is a way to
                  add one: the project select's first option, "Add a new
                  project…", is how a host with an empty list bootstraps its
                  first. */}
              {(cities.length > 0 || onProjectAdded) && (
                <>
                  <div className="stash-field">
                    <span className="stash-label">Host</span>
                    <HostPicker
                      hosts={hosts}
                      selectedId={selectedHostId}
                      onSelect={handleHostChange}
                      className="stash-select"
                    />
                  </div>
                  <div className="stash-field">
                    <span className="stash-label">Project</span>
                    <ProjectPicker
                      projects={hostCities}
                      selectedId={selectedCityId}
                      onSelect={setSelectedCityId}
                      onAddProject={onProjectAdded ? addProject.begin : undefined}
                      className="stash-select"
                    />
                  </div>
                </>
              )}

              {/* Parent fiber */}
              <label className="stash-field">
                <span className="stash-label">
                  Parent fiber <span className="stash-optional">opt</span>
                </span>
                <ParentPicker
                  value={parentSlug}
                  onChange={setParentSlug}
                  scopePrefix={selectedCity?.loomPrefix ?? ''}
                  shuttleBase={shuttleBase}
                />
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
            {parentValidation && (
              <div className="stash-hint stash-hint-warn">{parentValidation}</div>
            )}
          </section>

          {/* ── Section: WHAT — title, body, tags ── */}
          <section className="stash-section">
            <div className="stash-section-head">
              <span className="stash-section-label">What</span>
              <span className="stash-section-rule" aria-hidden="true" />
            </div>

            {/* Title */}
            <label className="stash-field">
              <span className="stash-label">Title</span>
              <input
                ref={titleRef}
                type="text"
                className="stash-input stash-input-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Look into garden lens"
                required
                maxLength={200}
              />
              {title.trim() && (
                <div className="stash-receipt">
                  <span className="stash-receipt-key">slug</span>
                  <span className="stash-receipt-sep">›</span>
                  <code className="stash-receipt-val">
                    {parentSlug ? `${parentSlug}/` : ''}{slugStem(title) || 'stash-…'}
                  </code>
                </div>
              )}
            </label>

            {/* Body */}
            <label className="stash-field">
              <span className="stash-label">
                Body <span className="stash-optional">opt</span>
              </span>
              <textarea
                className="stash-textarea"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Free-form blabbing — paragraphs, code, whatever. Skip if title is enough."
                rows={3}
              />
            </label>

            {/* Tags */}
            <div className="stash-field">
              <span className="stash-label">
                Tags <span className="stash-optional">opt</span>
              </span>
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
            </div>
          </section>

          {/* ── Section: DISPATCH — agent + kind (+ schedule when standing) ── */}
          <section className="stash-section">
            <div className="stash-section-head">
              <span className="stash-section-label">Dispatch</span>
              <span className="stash-section-rule" aria-hidden="true" />
            </div>
            <div className="stash-row stash-row-dispatch">
              {/* Agent */}
              <div className="stash-field">
                <span className="stash-label">Agent</span>
                {agents.length > 0 ? (
                  <select
                    className="stash-select"
                    value={agentId}
                    onChange={(e) => handleAgentChange(e.target.value)}
                  >
                    <option value="">Default ({defaultAgentLabel})</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {agentLabel(a)}{a.default ? ' (default)' : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    className="stash-input"
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                    placeholder="claude-sonnet (default)"
                  />
                )}
              </div>

              {/* Effort — registry-gated reasoning-effort axis. */}
              <div className="stash-field">
                <span className="stash-label">
                  Effort
                </span>
                <select
                  className="stash-select"
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
              </div>

              {/* Kind — segmented control */}
              <div className="stash-field">
                <span className="stash-label">Kind</span>
                <div className="stash-segmented" role="radiogroup" aria-label="Dispatch kind">
                  {KIND_SEGMENTS.map(([value, name, hint]) => (
                    <label
                      key={value}
                      className={
                        kind === value ? 'stash-segment stash-segment-active' : 'stash-segment'
                      }
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
              </div>
            </div>

            {/* Schedule + timezone, only when kind=standing */}
            {kind === 'standing' && (
              <div className="stash-row stash-row-schedule">
                <label className="stash-field stash-field-cron">
                  <span className="stash-label">Schedule</span>
                  <input
                    type="text"
                    className="stash-input stash-input-mono"
                    value={schedule}
                    onChange={(e) => setSchedule(e.target.value)}
                    placeholder="0 9 * * 1-5"
                    required
                  />
                  <div className="stash-hint">
                    5-field cron · e.g. <code>0 9 * * 1-5</code> (weekdays 09:00)
                  </div>
                </label>
                <label className="stash-field stash-field-tz">
                  <span className="stash-label">Timezone</span>
                  <input
                    type="text"
                    className="stash-input"
                    value={scheduleTz}
                    onChange={(e) => setScheduleTz(e.target.value)}
                    placeholder="Europe/Paris"
                  />
                  <div className="stash-hint">IANA name</div>
                </label>
              </div>
            )}

            {/* Worker-launch flags */}
            <div className="stash-field stash-field-flags">
              <span className="stash-label">Launch flags</span>
              <div className="stash-flag-row">
                <label className="stash-flag" style={chromeCapable ? undefined : { opacity: 0.45, cursor: 'not-allowed' }}>
                  <input
                    type="checkbox"
                    checked={chrome}
                    disabled={!chromeCapable}
                    onChange={(e) => setChrome(e.target.checked)}
                  />
                  <span className="stash-flag-name">
                    <code>--chrome</code>
                  </span>
                  <span className="stash-flag-hint">
                    {chromeCapable ? 'browser automation mode' : 'claude harness only'}
                  </span>
                </label>
              </div>
            </div>
          </section>

          {/* ── Error ── */}
          {error && (
            <div className="stash-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="stash-footer">
          <div className="stash-hint stash-hint-foot">
            <kbd>Esc</kbd> cancel <span className="stash-hint-dot">·</span> <kbd>⌘↵</kbd> save
          </div>
          <div className="stash-buttons">
            <button
              type="button"
              className="stash-btn stash-btn-cancel"
              onClick={onCancel}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="stash-btn stash-btn-save"
              onClick={() => void submit()}
              disabled={submitting || !title.trim()}
            >
              {submitting ? 'Stashing…' : 'Stash'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Inject the StashForm's CSS once. Idempotent — safe to call on every open.
 */
export function injectStashFormStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById('stash-form-styles')) return
  const style = document.createElement('style')
  style.id = 'stash-form-styles'
  style.textContent = `
    .stash-scrim {
      position: fixed;
      inset: 0;
      background: rgba(46, 42, 38, 0.45);
      z-index: 10001;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 40px 20px 20px;
      overflow: auto;
      animation: stash-scrim-in 120ms ease-out;
    }
    @keyframes stash-scrim-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .stash-card {
      width: 100%;
      max-width: 880px;
      max-height: calc(100vh - 80px);
      background: #F4F0E8;
      background-image:
        linear-gradient(135deg, rgba(154, 123, 53, 0.025) 0%, transparent 60%),
        linear-gradient(315deg, rgba(46, 42, 38, 0.020) 0%, transparent 70%);
      border: 1px solid rgba(46, 42, 38, 0.22);
      border-radius: 4px;
      box-shadow:
        0 1px 0 rgba(255, 252, 245, 0.6) inset,
        0 14px 36px rgba(46, 42, 38, 0.26),
        0 2px 6px rgba(46, 42, 38, 0.12);
      font-family: var(--font-main, 'EB Garamond', serif);
      color: #2E2A26;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      animation: stash-card-in 160ms ease-out;
    }
    @keyframes stash-card-in {
      from { transform: translateY(-6px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    .stash-header {
      position: relative;
      padding: 14px 22px 12px;
      background: #E5DED2;
      border-bottom: 1px solid rgba(46, 42, 38, 0.10);
      flex: none;
    }
    .stash-header-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }
    .stash-title {
      margin: 0;
      font-size: 19px;
      font-weight: 600;
      letter-spacing: 0.01em;
    }
    .stash-eyebrow {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 10px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: #9A8E80;
    }
    .stash-subtitle {
      font-style: italic;
      font-size: 13px;
      color: #7A7068;
      margin-top: 2px;
    }
    .stash-header-rule {
      position: absolute;
      left: 0;
      right: 0;
      bottom: -1px;
      height: 1px;
      background: linear-gradient(
        to right,
        transparent 0%,
        rgba(154, 123, 53, 0.0) 6%,
        rgba(154, 123, 53, 0.55) 50%,
        rgba(154, 123, 53, 0.0) 94%,
        transparent 100%
      );
    }
    .stash-body {
      padding: 14px 22px 16px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      overflow-y: auto;
      flex: 1 1 auto;
    }
    .stash-section {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .stash-section-head {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .stash-section-label {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #C49333;
      flex: none;
    }
    .stash-section-rule {
      flex: 1;
      height: 1px;
      background: linear-gradient(
        to right,
        rgba(46, 42, 38, 0.18) 0%,
        rgba(46, 42, 38, 0.05) 100%
      );
    }
    .stash-row {
      display: grid;
      gap: 12px;
    }
    /* Host · project · parent fiber, in equal columns. Host and project are
       both native selects now, and a select sized to its content would make
       the row read as three unrelated widths; equal thirds of the 880px card
       hold the project names without squeezing. */
    .stash-row-3 {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .stash-row-schedule {
      grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
      margin-top: 2px;
    }
    .stash-row-dispatch {
      grid-template-columns: minmax(0, 1.5fr) minmax(0, 0.8fr) minmax(0, 1.4fr);
    }
    @media (max-width: 700px) {
      .stash-row-2,
      .stash-row-3,
      .stash-row-dispatch,
      .stash-row-schedule {
        grid-template-columns: 1fr;
      }
    }
    .stash-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    .stash-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #5C544D;
      display: inline-flex;
      align-items: baseline;
      gap: 6px;
    }
    .stash-optional {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 9.5px;
      font-weight: 400;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: #B5A998;
      padding: 0 4px;
      border: 1px solid rgba(46, 42, 38, 0.10);
      border-radius: 2px;
    }
    .stash-input,
    .stash-textarea,
    .stash-tag-input,
    .stash-select {
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 15px;
      color: #2E2A26;
      background: #FFFFFF;
      border: 1px solid rgba(46, 42, 38, 0.20);
      border-radius: 3px;
      padding: 6px 9px;
      transition: border-color 120ms ease-out, box-shadow 120ms ease-out;
      width: 100%;
      box-sizing: border-box;
    }
    .stash-input-title {
      font-size: 17px;
      padding: 7px 10px;
    }
    .stash-select {
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%237A7068'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 10px center;
      padding-right: 28px;
      cursor: pointer;
    }
    .stash-input-mono {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 13px;
      letter-spacing: 0.02em;
    }
    .stash-textarea {
      resize: vertical;
      min-height: 64px;
      font-family: var(--font-main, 'EB Garamond', serif);
      line-height: 1.45;
    }
    .stash-input:focus,
    .stash-textarea:focus,
    .stash-tag-input:focus,
    .stash-select:focus {
      outline: none;
      border-color: #C49333;
      box-shadow: 0 0 0 2px rgba(154, 123, 53, 0.18);
    }
    .stash-hint {
      font-size: 12px;
      color: #7A7068;
      font-style: italic;
    }
    .stash-hint code {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 11px;
      font-style: normal;
      background: rgba(46, 42, 38, 0.06);
      padding: 1px 5px;
      border-radius: 2px;
    }
    .stash-hint-warn {
      color: #8C5A1A;
      font-style: normal;
      font-size: 12px;
    }
    .stash-receipt {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      align-self: flex-start;
      margin-top: 2px;
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
      background: transparent;
      padding: 0;
    }
    .stash-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      padding: 6px 8px;
      background: #FFFFFF;
      border: 1px solid rgba(46, 42, 38, 0.20);
      border-radius: 3px;
      min-height: 34px;
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
      padding: 2px 4px;
      background: transparent;
      box-shadow: none !important;
    }
    .stash-tag-input:focus {
      box-shadow: none;
    }
    .stash-suggestions {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 6px;
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
    .stash-segmented {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0;
      padding: 3px;
      background: #FFFFFF;
      border: 1px solid rgba(46, 42, 38, 0.20);
      border-radius: 3px;
    }
    .stash-segmented:focus-within {
      border-color: #C49333;
      box-shadow: 0 0 0 2px rgba(154, 123, 53, 0.18);
    }
    .stash-segment {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 1px;
      padding: 5px 9px;
      border-radius: 2px;
      cursor: pointer;
      transition: background 120ms ease-out, color 120ms ease-out;
      color: #5C544D;
      min-width: 0;
    }
    .stash-segment input[type="radio"] {
      position: absolute;
      opacity: 0;
      pointer-events: none;
      width: 0;
      height: 0;
    }
    .stash-segment-name {
      font-size: 13px;
      font-weight: 600;
      color: inherit;
      line-height: 1.2;
    }
    .stash-segment-hint {
      font-size: 11px;
      font-style: italic;
      color: #9A8E80;
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    .stash-segment:hover {
      background: rgba(154, 123, 53, 0.08);
    }
    .stash-segment-active {
      background: rgba(154, 123, 53, 0.18);
      color: #5A4520;
      box-shadow: inset 0 0 0 1px rgba(154, 123, 53, 0.42);
    }
    .stash-segment-active .stash-segment-hint {
      color: #7A6028;
    }
    .stash-field-flags {
      margin-top: 2px;
    }
    .stash-flag-row {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      padding: 6px 2px 0;
    }
    .stash-flag {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      user-select: none;
      font-size: 13px;
      color: #2E2A26;
    }
    .stash-flag input[type="checkbox"] {
      width: 14px;
      height: 14px;
      margin: 0;
      accent-color: #9A7B35;
      cursor: pointer;
    }
    .stash-flag-name {
      font-family: var(--font-main, 'EB Garamond', serif);
    }
    .stash-flag-name code {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 12px;
      background: rgba(46, 42, 38, 0.06);
      padding: 1px 5px;
      border-radius: 2px;
      color: #5A4520;
    }
    .stash-flag-hint {
      font-style: italic;
      font-size: 12px;
      color: #7A7068;
    }
    .stash-error {
      padding: 8px 10px;
      background: rgba(178, 78, 60, 0.12);
      border: 1px solid rgba(178, 78, 60, 0.5);
      color: #8B3A28;
      font-size: 13px;
      border-radius: 2px;
    }
    .stash-footer {
      padding: 10px 22px 14px;
      border-top: 1px solid rgba(46, 42, 38, 0.10);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      background: #EFEAE0;
      flex: none;
    }
    .stash-hint-foot {
      font-style: normal;
      color: #7A7068;
      font-size: 11px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .stash-hint-dot {
      color: #B5A998;
    }
    .stash-hint-foot kbd {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 10px;
      background: rgba(46, 42, 38, 0.10);
      padding: 1px 5px;
      border-radius: 2px;
      border: 1px solid rgba(46, 42, 38, 0.16);
      color: #4C453F;
    }
    .stash-buttons {
      display: flex;
      gap: 8px;
    }
    .stash-btn {
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 14px;
      padding: 6px 16px;
      border-radius: 3px;
      border: 1px solid transparent;
      cursor: pointer;
      transition: background 120ms ease-out, border-color 120ms ease-out, box-shadow 120ms ease-out;
      letter-spacing: 0.01em;
    }
    .stash-btn-cancel {
      background: transparent;
      color: #7A7068;
      border-color: rgba(46, 42, 38, 0.20);
    }
    .stash-btn-cancel:hover:not(:disabled) {
      background: rgba(46, 42, 38, 0.06);
      color: #2E2A26;
    }
    .stash-btn-save {
      background: #C49333;
      color: #FFFFFF;
      border-color: #7A6028;
      box-shadow: 0 1px 0 rgba(255, 252, 245, 0.25) inset;
    }
    .stash-btn-save:hover:not(:disabled) {
      background: #B08D3D;
    }
    .stash-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    /* ── The sheet: the form below 700px ──────────────────────────────────
       LAST IN THE SHEET ON PURPOSE. Every rule here is a single class
       answering another single class defined above it, so cascade order is
       the only thing that decides — move this block up and the phone
       silently gets the desktop's footer back. */
    @media (max-width: 700px) {
      /* The card stops being a card. A phone has no room to float paper over
         anything, so the scrim's padding goes and the form takes the screen —
         header, one scrolling body, and the footer pinned to the bottom edge,
         which is the only place Save can be while a keyboard is up. */
      .stash-scrim {
        padding: 0;
        overflow: hidden;
        align-items: stretch;
      }
      .stash-card {
        max-width: none;
        /* dvh, not vh: mobile browser chrome collapses, and vh keeps promising
           a taller screen than there is — which strands the footer below the
           fold exactly when the keyboard needs it visible. */
        height: 100dvh;
        max-height: 100dvh;
        border: none;
        border-radius: 0;
        box-shadow: none;
        padding-bottom: env(safe-area-inset-bottom, 0px);
      }
      .stash-header { padding: 12px 16px 10px; }
      .stash-body { padding: 12px 16px 16px; }
      .stash-footer {
        padding: 10px 16px calc(12px + env(safe-area-inset-bottom, 0px));
        flex-wrap: wrap;
      }
      /* The Esc / ⌘↵ hint is a keyboard's line; a phone has neither key. */
      .stash-hint-foot { display: none; }
      .stash-buttons {
        flex: 1;
        gap: 10px;
      }
      .stash-btn {
        flex: 1;
        min-height: 44px;
        font-size: 15px;
      }
      /* iOS zooms the page on focus for any field under 16px, and a zoomed
         page cannot be scrolled back. Every field, no exceptions. */
      .stash-input,
      .stash-textarea,
      .stash-tag-input,
      .stash-select,
      .stash-input-title {
        font-size: 16px;
        padding: 9px 10px;
      }
      .stash-select { padding-right: 30px; }
    }

  `
  document.head.appendChild(style)
  // The shared directory picker rides along: both forms that open it are opened
  // through this same injection point (Stash directly, Capture via mountForms).
  injectProjectPickerStyles()
}
