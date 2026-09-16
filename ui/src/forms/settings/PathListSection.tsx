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
 *
 * ## Where the rows come from, and why not from the feed
 *
 * The list is read from the OWNING HOST, through `GET /api/v1/config/:id`, not
 * from the origins feed the sheet already holds. The feed is a hub's cache,
 * and for a remote it has not heard from it reports an empty list — which is
 * indistinguishable, there, from a host that genuinely has none. Every write
 * here is a whole-list REPLACE, so seeding from that empty list and pressing
 * Add would have persisted a single row over that host's entire registry. A
 * live read cannot say "empty" about a host that never answered: it either
 * works or it fails, and a failure renders as a failure.
 *
 * Each save carries the digest that came with the list it is editing, so two
 * people editing one host's list cannot silently drop each other's rows.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { FileEditor } from './FileEditor'
import {
  addProject,
  chooseFolder,
  loadConfigFile,
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
        work to land. Kept separate from Stores on purpose: those are where the daemon reads,
        and these live in the protected directories reading stays out of. Adding one
        initializes its <code>.felt/</code> if it has none.
      </>
    ),
    addLabel: 'Add a project',
    empty:
      'No projects registered — the pickers fall back to deriving candidates from the store registry and the cards on the board.',
  },
}

/** The list as the owning host holds it, with the digest that guards a replace. */
interface Loaded {
  paths: string[]
  digest: string | null
}

export function PathListSection({
  shuttleBase,
  host,
  kind,
  summary,
  onChanged,
}: PathListSectionProps): JSX.Element {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [fileToken, setFileToken] = useState(0)

  const read = useCallback(
    (keepNote = false): Promise<void> => {
      if (!keepNote) setNote(null)
      setError(null)
      return loadConfigFile(shuttleBase, host, kind)
        .then((file) => {
          setLoaded({ paths: file.entries ?? [], digest: file.digest ?? null })
        })
        .catch((err: Error) => {
          setLoaded(null)
          setError(err.message)
        })
    },
    [shuttleBase, host, kind],
  )

  // Mount, and every host or section switch. The list is dropped to null
  // BEFORE the new read is issued, so a slow answer can never paint one host's
  // paths under another host's name — the state this page must never reach.
  const readRef = useRef(read)
  readRef.current = read
  useEffect(() => {
    setLoaded(null)
    setTyped('')
    setNote(null)
    void readRef.current()
  }, [shuttleBase, host.origin, kind])

  const paths = loaded?.paths ?? []

  const persist = async (next: string[]): Promise<void> => {
    if (busy || !loaded) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      if (kind === 'stores') await saveStores(shuttleBase, host, next, loaded.digest)
      else await saveProjects(shuttleBase, host, next, loaded.digest)
      await read()
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
    if (!path || !loaded) return
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
      setTyped('')
      // The note is set BEFORE the refresh and survives it. It is the
      // confirmation for the only call here that creates anything on disk, and
      // a refresh that cleared it made that confirmation flash and vanish.
      if (result.initialized) setNote(`Initialized a new felt store at ${result.path}.`)
      else if (!result.registered) setNote(`${result.path} was already registered.`)
      await read(true)
      setFileToken((n) => n + 1)
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const pick = async (): Promise<void> => {
    if (busy) return
    setError(null)
    setNote(null)
    setBusy(true)
    try {
      const result = await chooseFolder(shuttleBase, host)
      if (result.path) {
        setBusy(false)
        await add(result.path)
        return
      }
      // No path, no error. The dialog was dismissed — or it never opened, which
      // every mechanism reports the same way a dismissal looks. Saying so beats
      // the silence this used to answer with after a long wait.
      setNote(
        host.isLocal
          ? 'No folder chosen.'
          : `No folder came back from ${host.label}. Either someone dismissed it there, or that host could not raise a dialog — type the path instead.`,
      )
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const copy = COPY[kind]

  // The compact environment form wins over the file outright, so while it is
  // set the file is read by nobody and editing it would have no effect. The
  // override arrives on the config index, which the parent refetches after
  // every save — and during that refetch `summary` is briefly undefined.
  // `undefined` must not read as "not overridden", or the controls this guard
  // exists to disable would blink back on mid-round-trip. So an override, once
  // seen, is latched for the life of this mount.
  const latched = useRef<ConfigFileSummary['env_override']>(null)
  if (summary?.env_override) latched.current = summary.env_override
  const overridden = summary?.env_override ?? latched.current
  const frozen = busy || overridden !== null || loaded === null

  /**
   * The symlinked substores the daemon reaches through the roots ABOVE.
   *
   * Suppressed under an environment override, and that is not fussiness. The
   * rows are the FILE's list; `expandedFeltStores` is the expansion of what the
   * daemon actually polls, which under `FELT_STORES` is a different list
   * entirely. Subtracting one from the other then labels whatever the env
   * expansion has and the file lacks "a symlinked substore of those roots" —
   * about roots it is not reached through. Two lists that are not about the
   * same thing should not be subtracted.
   */
  const substores =
    kind === 'stores' && !overridden && host.expandedFeltStores
      ? host.expandedFeltStores.filter((p) => !paths.includes(p))
      : []

  return (
    <>
      <p className="set-lede">{copy.lede}</p>

      {overridden && (
        <div className="set-error" role="status">
          <span className="set-mono">{overridden.var}</span> is set in this daemon’s
          environment, so it is reading <span className="set-mono">{overridden.value}</span> and{' '}
          <span className="set-mono">{copy.filename}</span> is read by nobody. Editing is off
          for that reason — a change to the file would have no effect until the variable is
          unset and the daemon restarts. The file’s own contents are still at the bottom of
          this page.
        </div>
      )}

      {loaded === null && !error && <div className="set-empty">Reading…</div>}

      {loaded !== null && paths.length > 0 && (
        <div className="set-section-label">
          {paths.length} {kind === 'stores' ? 'store' : 'project'}
          {paths.length === 1 ? '' : 's'} in {copy.filename}
        </div>
      )}

      {loaded !== null &&
        (paths.length === 0 ? (
          <div className="set-empty">{copy.empty}</div>
        ) : (
          <ul className="set-list">
            {paths.map((path) => (
              <li className="set-row" key={path}>
                <span className="set-row-main">
                  <span className="set-row-path">{path}</span>
                  {paths.length === 1 && !overridden && (
                    <span className="set-row-note set-row-note-owed">
                      the last one — removing it deletes {copy.filename}
                    </span>
                  )}
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
        ))}

      {substores.length > 0 && (
        <p className="set-row-note" style={{ marginTop: '8px' }}>
          Plus {substores.length} symlinked substore{substores.length === 1 ? '' : 's'} the
          daemon reaches through {paths.length === 1 ? 'that root' : 'those roots'}:{' '}
          <span className="set-mono">{substores.join(', ')}</span>
        </p>
      )}

      {/* Nothing to add to a list that could not be read. A disabled form under
          "this host has no settings API" is furniture, not an affordance. */}
      {!overridden && loaded !== null && (
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
            {host.nativeFolderPicker && (
              <button
                type="button"
                className="set-btn"
                disabled={frozen}
                title={
                  host.isLocal
                    ? undefined
                    : `Opens a folder dialog on ${host.label}, and waits for someone there to answer it`
                }
                onClick={() => void pick()}
              >
                Browse…
              </button>
            )}
          </div>
          {!host.isLocal && (
            <p className="set-row-note" style={{ marginTop: '6px' }}>
              Type the path as it exists on {host.label}.
              {host.nativeFolderPicker
                ? ' Browse raises a dialog on that machine’s own desktop and waits for someone there to answer it.'
                : ' That host reports no folder dialog, so there is nothing to browse with.'}
            </p>
          )}
        </>
      )}

      {note && <div className="set-said">{note}</div>}
      {error && (
        <div className="set-error" role="alert">
          {error}
        </div>
      )}

      <FileEditor
        shuttleBase={shuttleBase}
        host={host}
        id={kind}
        reloadToken={fileToken}
        onSaved={() => {
          void read()
          onChanged()
        }}
      />
    </>
  )
}
