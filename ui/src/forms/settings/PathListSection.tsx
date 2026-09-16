/**
 * Stores and Projects — one component, because they are the same shape and
 * almost none of the same thing.
 *
 * Both are flat lists of absolute paths on one host, so both get the same
 * surface: a row per path with a way to drop it, a way to add one, and the
 * file underneath. What differs is what a path MEANS, which is the whole
 * reason `stores.json` and `projects.json` are two files rather than one:
 *
 *   - a **store** is where the daemon enumerates fibers. On macOS it is kept
 *     clear of `~/Documents` so polling never touches TCC-protected paths.
 *   - a **project** is a checkout a human can file new work into, and those
 *     live in exactly the protected places the poll list stays out of.
 *
 * Conflating them drags polling into Full-Disk-Access territory, which is the
 * bug the split exists to prevent — so this component never offers to copy a
 * path from one list to the other, however convenient that would look.
 *
 * Adding differs too, and it is the more consequential difference. Registering
 * a **project** initializes its `.felt/` if it has none: that call creates
 * something on the host's disk, and it is the only one on this page that does.
 * Adding a **store** only writes the list — a directory with no `.felt/` in it
 * is simply a store with no fibers, which the poller reads as empty rather
 * than as an error.
 */

import { useEffect, useState } from 'react'

import { FileEditor } from './FileEditor'
import {
  addProject,
  chooseFolder,
  saveProjects,
  saveStores,
  type ConfigFileSummary,
  type SettingsHost,
} from './settingsApi'

export type PathListKind = 'stores' | 'projects'

export interface PathListSectionProps {
  shuttleBase: string
  host: SettingsHost
  kind: PathListKind
  /** This file's row from the config index — for the environment-override warning. */
  summary: ConfigFileSummary | undefined
  /** The host's lists were rewritten; the page should refetch its origins. */
  onChanged: () => void
}

const COPY: Record<
  PathListKind,
  { lede: JSX.Element; addLabel: string; empty: string; filename: string }
> = {
  stores: {
    filename: 'stores.json',
    lede: (
      <>
        The felt stores this daemon <strong>polls</strong> — every fiber it can see, dispatch
        and serve lives under one of these. A store is any directory with a <code>.felt/</code>{' '}
        inside it. Symlinked substores are followed, so one store root can stand for many
        projects.
      </>
    ),
    addLabel: 'Add a store',
    empty: 'No stores configured — this daemon polls nothing and dispatches nothing.',
  },
  projects: {
    filename: 'projects.json',
    lede: (
      <>
        The checkouts the <strong>Stash and Capture</strong> pickers offer as somewhere for new
        work to land. Kept separate from the poll list above on purpose: these live in the
        protected directories polling stays out of. Adding one initializes its{' '}
        <code>.felt/</code> if it has none.
      </>
    ),
    addLabel: 'Add a project',
    empty:
      'No projects registered — the pickers fall back to deriving candidates from the store registry and the cards on the board.',
  },
}

export function PathListSection({
  shuttleBase,
  host,
  kind,
  summary,
  onChanged,
}: PathListSectionProps): JSX.Element {
  const source = kind === 'stores' ? host.feltStores : host.projects
  const [paths, setPaths] = useState<string[]>(source)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [fileToken, setFileToken] = useState(0)

  // The host's own lists ride in on the origins feed, so they are already here
  // when this mounts — and they are re-read whenever the parent refetches, so
  // a save made from the file editor below shows up in the rows above it.
  useEffect(() => {
    setPaths(source)
    setError(null)
    setNote(null)
  }, [host.origin, kind, source.join('\n')])

  const persist = async (next: string[], said?: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const saved =
        kind === 'stores'
          ? (await saveStores(shuttleBase, host, next)).felt_stores
          : (await saveProjects(shuttleBase, host, next)).projects
      setPaths(saved ?? next)
      if (said) setNote(said)
      setFileToken((n) => n + 1)
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const add = async (raw: string): Promise<void> => {
    const path = raw.trim()
    if (!path) return
    if (paths.includes(path)) {
      setError(`${path} is already on the list.`)
      return
    }
    if (kind === 'stores') {
      setTyped('')
      await persist([...paths, path])
      return
    }
    // Projects go through the endpoint that also creates the store, so the
    // answer can say whether it made one — a fact worth reporting, since it is
    // the only thing this page writes to disk that is not a config file.
    if (busy) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const result = await addProject(shuttleBase, host, path)
      setPaths(result.projects ?? [...paths, path])
      setTyped('')
      setNote(
        result.initialized
          ? `Initialized a new felt store at ${result.path}.`
          : result.registered
            ? null
            : `${result.path} was already registered.`,
      )
      setFileToken((n) => n + 1)
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const pick = async (): Promise<void> => {
    setError(null)
    try {
      const result = await chooseFolder(shuttleBase)
      if (result.cancelled || !result.path) return
      await add(result.path)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const copy = COPY[kind]
  const expanded = kind === 'stores' ? host.expandedFeltStores : null
  const extra = expanded ? expanded.filter((p) => !paths.includes(p)) : []
  // The compact environment form wins over the file outright, so while it is
  // set the rows below are the ENVIRONMENT's list and the file is read by
  // nobody. Editing the list would write a file with no effect, which is worse
  // than not offering to: the controls go away and the banner says where the
  // value is really coming from. The file editor stays — it shows the file's
  // own contents, honestly labelled as unread.
  const overridden = summary?.env_override ?? null
  const frozen = busy || overridden !== null

  return (
    <>
      <p className="set-lede">{copy.lede}</p>

      {overridden && (
        <div className="set-error" role="status">
          <span className="set-mono">{overridden.var}</span> is set in this daemon’s
          environment, so the list below is coming from there and{' '}
          <span className="set-mono">{copy.filename}</span> is read by nobody. Editing is off
          for that reason — a change to the file would have no effect until the variable is
          unset and the daemon restarts. The file’s own contents are still at the bottom of
          this page.
        </div>
      )}

      {paths.length === 0 ? (
        <div className="set-empty">{copy.empty}</div>
      ) : (
        <ul className="set-list">
          {paths.map((path) => (
            <li className="set-row" key={path}>
              <span className="set-row-main">
                <span className="set-row-path">{path}</span>
              </span>
              {!overridden && (
                <button
                  type="button"
                  className="set-btn set-btn-drop"
                  disabled={frozen}
                  title={`Remove ${path} from the list`}
                  aria-label={`Remove ${path}`}
                  onClick={() => void persist(paths.filter((p) => p !== path))}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {extra.length > 0 && (
        <p className="set-row-note" style={{ marginTop: '8px' }}>
          Plus {extra.length} symlinked substore{extra.length === 1 ? '' : 's'} the daemon
          reaches through {paths.length === 1 ? 'that root' : 'those roots'}:{' '}
          <span className="set-mono">{extra.join(', ')}</span>
        </p>
      )}

      {!overridden && (
        <>
          <div className="set-section-label">{copy.addLabel}</div>
          <div className="set-actions">
            <input
              className="set-input"
              style={{ flex: '1 1 16rem', minWidth: 0 }}
              placeholder="/absolute/path/on/this/host"
              value={typed}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              disabled={frozen}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void add(typed)
                }
              }}
              aria-label={copy.addLabel}
            />
            <button
              type="button"
              className="set-btn set-btn-primary"
              disabled={frozen || typed.trim() === ''}
              onClick={() => void add(typed)}
            >
              Add
            </button>
            {host.nativeFolderPicker && host.isLocal && (
              <button
                type="button"
                className="set-btn"
                disabled={frozen}
                onClick={() => void pick()}
              >
                Browse…
              </button>
            )}
          </div>
          {!host.isLocal && (
            <p className="set-row-note" style={{ marginTop: '6px' }}>
              Type the path as it exists on {host.label}. There is no folder dialog for a remote
              — it would open on a desktop nobody is sitting at.
            </p>
          )}
        </>
      )}

      {note && <div className="set-said">{note}</div>}
      {error && <div className="set-error" role="alert">{error}</div>}

      <FileEditor
        shuttleBase={shuttleBase}
        host={host}
        id={kind}
        reloadToken={fileToken}
        onSaved={onChanged}
      />
    </>
  )
}
