/**
 * Host class — `host.json`, the file that decides whether this daemon listens
 * on a loopback TCP port or a Unix socket, and who else on the machine may
 * reach it.
 *
 * One structured gesture (a select for `"class"`) over the same raw editor
 * every other file gets, on the same reasoning as `AgentsSection`: a select
 * writes ONE key by reading the file, patching it, and posting the whole text
 * back — never re-encoding the document from a partial model, so an unknown
 * key (a future `"listen"` sibling, say) rides through untouched. There is no
 * dedicated write endpoint for this field the way effort has one; the select
 * is a convenience over `POST /api/v1/config/host`, the same route the editor
 * below uses, so the two can never disagree about what "saved" means.
 *
 * The daemon reads this file once at boot (`Shuttle.host_class/0`,
 * `Shuttle.listen/0`), so a save here takes effect at the next restart, not
 * immediately — the help text says so rather than implying a live toggle.
 */

import { useEffect, useState } from 'react'

import { FileEditor } from './FileEditor'
import {
  HOST_CLASSES,
  isConflict,
  loadConfigFile,
  saveConfigFile,
  type ConfigFileSummary,
  type HostClass,
  type SettingsHost,
} from './settingsApi'

const CLASS_HELP: Record<HostClass, string> = {
  'single-user':
    'loopback is yours alone — a laptop or a workstation nobody else logs into.',
  'shared-multi-user':
    'a login node other accounts share — the daemon listens on a Unix socket instead of a TCP port.',
  exposed:
    'reachable beyond this machine — the narrowest of the three, meant for a daemon fronted by something that itself authenticates.',
}

export interface HostClassSectionProps {
  shuttleBase: string
  host: SettingsHost
  summary: ConfigFileSummary | undefined
  onChanged: () => void
}

export function HostClassSection({
  shuttleBase,
  host,
  summary,
  onChanged,
}: HostClassSectionProps): JSX.Element {
  const [doc, setDoc] = useState<{ parsed: Record<string, unknown> | null; digest: string | null } | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState(0)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    setDoc(null)
    setError(null)
    loadConfigFile(shuttleBase, host, 'host')
      .then((file) => {
        if (cancelled) return
        if (file.text.trim() === '') {
          setDoc({ parsed: {}, digest: file.digest })
          return
        }
        try {
          const parsed = JSON.parse(file.text) as Record<string, unknown>
          setDoc({ parsed, digest: file.digest })
        } catch {
          // Malformed JSON already on disk. The select has nothing sound to
          // patch, so it stays off; the raw editor below is still the way in.
          setDoc({ parsed: null, digest: file.digest })
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [shuttleBase, host.origin, token])

  const changeClass = async (value: string): Promise<void> => {
    if (!doc || doc.parsed === null) return
    setSaving(true)
    setError(null)
    try {
      const next = { ...doc.parsed, class: value }
      const text = JSON.stringify(next, null, 2) + '\n'
      await saveConfigFile(shuttleBase, host, 'host', text, doc.digest)
      setToken((n) => n + 1)
      onChanged()
    } catch (err) {
      setError(
        isConflict(err)
          ? `${(err as Error).message} Reopen this tab — that file changed underneath.`
          : (err as Error).message,
      )
    } finally {
      setSaving(false)
    }
  }

  const currentClass = (doc?.parsed?.class as string | undefined) ?? 'single-user'

  return (
    <>
      <p className="set-lede">
        Whether {host.label}'s daemon listens on a loopback port anyone local can reach, or on a
        Unix socket scoped to this account. Missing <span className="set-mono">host.json</span>{' '}
        or a missing <span className="set-mono">"class"</span> key both read as{' '}
        <span className="set-mono">single-user</span>. Takes effect at the next daemon restart.
      </p>

      {error && <div className="set-error" role="alert">{error}</div>}

      {doc === null && !error && <div className="set-empty">Reading…</div>}

      {doc !== null && (
        <>
          <div className="set-section-label">Class</div>
          <ul className="set-list">
            <li className="set-row">
              <span className="set-row-main">
                <select
                  className="set-select"
                  aria-label={`Host class for ${host.label}`}
                  value={currentClass}
                  disabled={saving || doc.parsed === null}
                  onChange={(e) => void changeClass(e.target.value)}
                >
                  {HOST_CLASSES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <span className="set-row-note" style={{ marginTop: '6px' }}>
                  {CLASS_HELP[(currentClass as HostClass) in CLASS_HELP ? (currentClass as HostClass) : 'single-user']}
                </span>
              </span>
            </li>
          </ul>
          {doc.parsed === null && (
            <p className="set-row-note" style={{ marginTop: '8px' }}>
              {host.label}'s <span className="set-mono">host.json</span> is not valid JSON, so
              there is nothing sound for this select to patch. Fix it in the raw editor below.
            </p>
          )}
        </>
      )}

      {summary && !summary.exists && (
        <p className="set-row-note" style={{ marginTop: '10px' }}>
          {host.label} has no <span className="set-mono">host.json</span> — it is running as{' '}
          <span className="set-mono">single-user</span> by default.
        </p>
      )}

      <FileEditor
        shuttleBase={shuttleBase}
        host={host}
        id="host"
        reloadToken={token}
        onSaved={() => {
          setToken((n) => n + 1)
          onChanged()
        }}
      />
    </>
  )
}
