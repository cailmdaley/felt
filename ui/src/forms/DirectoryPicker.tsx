/**
 * DirectoryPicker — the "+ Add project…" affordance shared by both project
 * pickers (Stash's combobox, Capture's `<select>`).
 *
 * A project used to reach the pickers only by hand-editing
 * `~/.config/felt/projects.json`. This walks the daemon's filesystem instead:
 * `GET /api/v1/browse?path=…` lists a directory's subdirectories (marking the
 * ones that already carry a `.felt/`), clicking one descends, and "Add this
 * folder" POSTs it to `POST /api/v1/projects`, which initializes the store if
 * needed and appends the path to the curated list.
 *
 * It renders as an overlay INSIDE its host form's DOM — not a portal — so
 * Capture's Radix focus trap keeps working and Stash's scrim click-to-close
 * doesn't fire underneath it. Its own styles are injected by id, following
 * `injectStashFormStyles`; the palette is Stash's paper so one component can
 * sit in both forms without looking borrowed.
 *
 * The caller owns what happens after: `onAdded(path)` hands back the registered
 * absolute path, and the form re-derives its project list from the daemon (the
 * POST response's `projects` is the same list, but `deriveProjects` stays the
 * single source of truth for project *shape*).
 */

import { useCallback, useEffect, useState } from 'react'

export interface BrowseEntry {
  name: string
  path: string
  hasFelt: boolean
}

export interface BrowseListing {
  path: string
  parent: string | null
  entries: BrowseEntry[]
}

/**
 * Parse a `/api/v1/browse` body defensively — an old daemon, a proxy error page
 * or a forwarded remote failure must degrade to an empty listing, never throw
 * inside render. Exported for the unit test.
 */
export function parseBrowseListing(body: unknown): BrowseListing {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { path: '', parent: null, entries: [] }
  const rec = body as Record<string, unknown>
  const rawEntries = Array.isArray(rec.entries) ? rec.entries : []
  const entries: BrowseEntry[] = []
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== 'object') continue
    const e = raw as Record<string, unknown>
    if (typeof e.name !== 'string' || typeof e.path !== 'string') continue
    entries.push({ name: e.name, path: e.path, hasFelt: e.has_felt === true })
  }
  return {
    path: typeof rec.path === 'string' ? rec.path : '',
    parent: typeof rec.parent === 'string' && rec.parent ? rec.parent : null,
    entries,
  }
}

/** `/a/b/c` → `['/a', '/a/b', '/a/b/c']`, for the breadcrumb header. */
export function crumbs(path: string): Array<{ label: string; path: string }> {
  if (!path.startsWith('/')) return []
  const segs = path.split('/').filter(Boolean)
  const out = [{ label: '/', path: '/' }]
  let acc = ''
  for (const seg of segs) {
    acc += `/${seg}`
    out.push({ label: seg, path: acc })
  }
  return out
}

export interface DirectoryPickerProps {
  /** Shuttle daemon base. Defaults to `''` (relative / same-origin). */
  shuttleBase?: string
  /** Whose filesystem to walk — `'local'` or a remote host name (owner-routed
   *  at the daemon, exactly like every other origin-stamped call). */
  origin?: string
  /** Where to open. Omitted → the daemon's own home directory. */
  initialPath?: string
  /** The registered absolute path, after a successful POST. */
  onAdded: (path: string) => void | Promise<void>
  onCancel: () => void
}

export function DirectoryPicker({
  shuttleBase = '',
  origin = 'local',
  initialPath,
  onAdded,
  onCancel,
}: DirectoryPickerProps): JSX.Element {
  const [listing, setListing] = useState<BrowseListing | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [path, setPath] = useState<string | undefined>(initialPath)

  const load = useCallback(
    async (target?: string): Promise<void> => {
      setLoading(true)
      setError(null)
      const query = new URLSearchParams()
      if (target) query.set('path', target)
      if (origin && origin !== 'local') query.set('origin', origin)
      try {
        const res = await fetch(`${shuttleBase}/api/v1/browse?${query.toString()}`)
        const body: unknown = await res.json().catch(() => undefined)
        if (!res.ok) {
          setError(errorOf(body) ?? `browse failed (${res.status})`)
          return
        }
        setListing(parseBrowseListing(body))
      } catch {
        setError('Couldn’t reach the Shuttle daemon.')
      } finally {
        setLoading(false)
      }
    },
    [shuttleBase, origin],
  )

  useEffect(() => {
    void load(path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  const add = async (): Promise<void> => {
    const target = listing?.path
    if (!target || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${shuttleBase}/api/v1/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(origin && origin !== 'local' ? { path: target, origin } : { path: target }),
      })
      const body: unknown = await res.json().catch(() => undefined)
      if (!res.ok) {
        setError(errorOf(body) ?? `couldn’t add project (${res.status})`)
        return
      }
      await onAdded(target)
    } catch {
      setError('Couldn’t reach the Shuttle daemon.')
    } finally {
      setBusy(false)
    }
  }

  const trail = crumbs(listing?.path ?? '')

  return (
    <div
      className="dirpick-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      <div className="dirpick-card" role="dialog" aria-modal="true" aria-label="Add a project">
        <div className="dirpick-header">
          <span className="dirpick-title">Add a project</span>
          <span className="dirpick-eyebrow">{origin === 'local' ? 'this host' : origin}</span>
        </div>

        <div className="dirpick-crumbs">
          {trail.map((c, i) => (
            <button
              key={c.path}
              type="button"
              className="dirpick-crumb"
              onClick={() => setPath(c.path)}
              disabled={i === trail.length - 1}
            >
              {c.label}
            </button>
          ))}
        </div>

        <div className="dirpick-list">
          {listing?.parent && (
            <button type="button" className="dirpick-row dirpick-up" onClick={() => setPath(listing.parent!)}>
              ..
            </button>
          )}
          {listing?.entries.map((e) => (
            <button key={e.path} type="button" className="dirpick-row" onClick={() => setPath(e.path)}>
              <span className="dirpick-name">{e.name}</span>
              {e.hasFelt && <span className="dirpick-felt">felt</span>}
            </button>
          ))}
          {!loading && listing && listing.entries.length === 0 && (
            <div className="dirpick-empty">No subfolders here.</div>
          )}
          {loading && <div className="dirpick-empty">Reading…</div>}
        </div>

        {error && <div className="dirpick-error">{error}</div>}

        <div className="dirpick-actions">
          <button type="button" className="dirpick-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="dirpick-btn dirpick-btn-primary"
            onClick={() => void add()}
            disabled={busy || !listing?.path}
          >
            {busy ? 'Adding…' : 'Add this folder'}
          </button>
        </div>
      </div>
    </div>
  )
}

function errorOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const err = (body as Record<string, unknown>).error
  return typeof err === 'string' && err ? err : null
}

/**
 * Inject the DirectoryPicker's CSS once. Idempotent by element id, the same
 * pattern `injectStashFormStyles` uses — Capture styles its own chrome inline,
 * so the component carries its own sheet rather than leaning on Stash's.
 */
export function injectDirectoryPickerStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById('directory-picker-styles')) return
  const style = document.createElement('style')
  style.id = 'directory-picker-styles'
  style.textContent = `
    .dirpick-scrim {
      position: fixed;
      inset: 0;
      background: rgba(46, 42, 38, 0.45);
      z-index: 10050;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 60px 20px 20px;
      overflow: auto;
    }
    .dirpick-card {
      width: min(520px, 100%);
      background: #F4F0E8;
      border: 1px solid rgba(46, 42, 38, 0.18);
      border-radius: 4px;
      box-shadow: 0 12px 32px rgba(46, 42, 38, 0.28);
      padding: 14px 16px 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .dirpick-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
    }
    .dirpick-title {
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 17px;
      color: #2E2A26;
    }
    .dirpick-eyebrow {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #7A7068;
    }
    .dirpick-crumbs {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 2px;
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 11px;
    }
    .dirpick-crumb {
      background: transparent;
      border: none;
      padding: 1px 3px;
      border-radius: 2px;
      color: rgba(154, 123, 53, 0.95);
      cursor: pointer;
      font: inherit;
    }
    .dirpick-crumb:hover:not(:disabled) {
      background: rgba(154, 123, 53, 0.16);
    }
    .dirpick-crumb:disabled {
      color: #2E2A26;
      cursor: default;
    }
    .dirpick-crumb + .dirpick-crumb::before {
      content: '/';
      color: #7A7068;
      margin-right: 3px;
    }
    .dirpick-list {
      max-height: 300px;
      overflow-y: auto;
      background: #FFFFFF;
      border: 1px solid rgba(46, 42, 38, 0.18);
      border-radius: 3px;
      padding: 4px;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .dirpick-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 9px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 2px;
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 14px;
      color: #2E2A26;
      text-align: left;
      cursor: pointer;
    }
    .dirpick-row:hover,
    .dirpick-row:focus-visible {
      background: rgba(154, 123, 53, 0.14);
      outline: none;
    }
    .dirpick-up {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 12px;
      color: #7A7068;
    }
    .dirpick-felt {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 9.5px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: rgba(154, 123, 53, 0.95);
      border: 1px solid rgba(154, 123, 53, 0.45);
      border-radius: 2px;
      padding: 0 4px;
    }
    .dirpick-empty {
      padding: 8px 10px;
      font-size: 12px;
      color: #7A7068;
      font-style: italic;
    }
    .dirpick-error {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 11px;
      color: #8C3A2B;
      line-height: 1.4;
    }
    .dirpick-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .dirpick-btn {
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 14px;
      padding: 5px 12px;
      background: #FFFFFF;
      color: #2E2A26;
      border: 1px solid rgba(46, 42, 38, 0.22);
      border-radius: 3px;
      cursor: pointer;
    }
    .dirpick-btn:hover:not(:disabled) {
      background: rgba(154, 123, 53, 0.12);
    }
    .dirpick-btn-primary {
      background: rgba(154, 123, 53, 0.22);
      border-color: rgba(154, 123, 53, 0.55);
    }
    .dirpick-btn:disabled {
      opacity: 0.55;
      cursor: default;
    }
  `
  document.head.appendChild(style)
}
