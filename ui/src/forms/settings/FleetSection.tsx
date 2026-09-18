/**
 * Fleet — which other daemons this host aggregates, how it reaches each, and
 * whether each is answering.
 *
 * A row keeps three claims apart rather than collapsing them into a status
 * light, because they fail independently and the difference is always the
 * thing you need:
 *
 *   - **how it is reached** — a Tailscale URL, or a local port this host
 *     forwards through a supervised tunnel. Read off the NORMALIZED file, so
 *     what you see is what the daemon acts on rather than what the file's text
 *     happens to say.
 *   - **whether it answered** — the hub's cached poll, never a fresh probe
 *     fired by opening this page. A page that healed the fleet by being looked
 *     at would be useless for diagnosing it.
 *   - **what it is running** — the remote's own build stamp, so a half-deployed
 *     fleet is visible here instead of in five terminal windows.
 *
 * ## Adding, and why the file is right below
 *
 * The add form shells `felt shuttle remotes add`, which is the fleet file's
 * only writer. That verb is **add-or-replace, wholesale**, and it has no flag
 * for `enabled`, `auth`, `ssh_flags`, `tunnel.label` or the per-entry
 * timeouts — so re-adding an entry that carries one of those drops it. The
 * form therefore does not offer to edit an existing row: it adds new ones, and
 * anything already in the file is changed in the file.
 *
 * ## Tunnels
 *
 * A remote reached by `url` needs no tunnel. A remote reached by `port` needs
 * a supervised `autossh` job on THIS host, and `felt shuttle tunnels install`
 * writes them: with no name it is convergent, installing every managed remote
 * and pruning any job the file no longer asks for. Preview is that verb's own
 * `--dry-run` — it reports both halves and touches nothing.
 */

import { useEffect, useRef, useState } from 'react'

import { FileEditor } from './FileEditor'
import { useSettingsDraft } from './SettingsDraftContext'
import {
  loadFleet,
  removeRemote,
  resetRemote,
  runTunnels,
  saveRemote,
  type Fleet,
  type FleetRemote,
  type SettingsHost,
} from './settingsApi'

export interface FleetSectionProps {
  shuttleBase: string
  host: SettingsHost
  onChanged: () => void
}

/**
 * How often the open sheet re-reads the fleet.
 *
 * Slower than the board's own 15s, deliberately. This read is not free on the
 * far side: it shells `felt shuttle remotes list` on the host being looked at,
 * and that host can be a shared cluster login node where the Runner's own
 * moduledoc records a felt call taking ~11s under IO pressure. Half a minute
 * is still far inside the window where a staleness clock reads honestly, and
 * it is a third of the subprocesses. A hidden tab skips the tick entirely — a
 * sheet left open behind another window should cost the fleet nothing.
 */
const FLEET_POLL_MS = 30_000

/** "3m ago" / "2h ago" — a poll's age, which is what staleness is made of. */
function ago(iso: string | null): string {
  if (!iso) return 'never'
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 'unknown'
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`
  return `${Math.round(secs / 86400)}d ago`
}

/** How this host reaches that one, in one line. */
function transport(remote: FleetRemote): string {
  const manager = remote.tunnel?.manager
  if (remote.port) {
    const via = [`:${remote.port} → ${remote.ssh ?? remote.name}:${remote.remote_port ?? 4000}`]
    if (manager && manager !== 'none') via.push(`${manager} tunnel`)
    if (remote.tunnel?.multiplex) via.push('multiplex')
    return via.join(' · ')
  }
  return [remote.url ?? '(no address)', remote.ssh ? `ssh ${remote.ssh}` : null]
    .filter(Boolean)
    .join(' · ')
}

export function FleetSection({ shuttleBase, host, onChanged }: FleetSectionProps): JSX.Element {
  const [fleet, setFleet] = useState<Fleet | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [token, setToken] = useState(0)
  const [adding, setAdding] = useState(false)
  /** The quiet refetch stopped working. The rows are still drawn, marked. */
  const [drifted, setDrifted] = useState(false)
  const [draft, setDraft] = useState({ name: '', url: '', ssh: '', port: '', checkout: '' })
  useSettingsDraft('remote-form', Object.values(draft).some((value) => value.trim() !== ''), busy)

  useEffect(() => {
    let cancelled = false
    setFleet(null)
    setError(null)
    setSaid(null)
    loadFleet(shuttleBase, host)
      .then((data) => {
        if (cancelled) return
        setFleet(data)
        // Any successful read clears it, not only the timer's. A manual
        // refresh that worked left the page insisting the ages were frozen
        // for a further poll interval — which is itself a stale claim about
        // staleness.
        setDrifted(false)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [shuttleBase, host.origin, token])

  /**
   * Keep the rows live while the sheet is open, on the board's own cadence.
   *
   * Not a nicety. “answering · 4s ago” is computed from a fixed timestamp at
   * render, so without this the row would still read “4s ago” twenty minutes
   * after a remote stopped answering — a settings page asserting a freshness
   * it stopped knowing about. The refetch is quiet: it replaces the rows on
   * success and leaves a failure, and whatever a button last said, alone,
   * because a poll landing mid-edit must not blank the page under you.
   */
  useEffect(() => {
    const id = window.setInterval(() => {
      // `busy` is read through a ref rather than a dependency: putting it in
      // the deps restarted this timer on every button press, so a run of
      // clicks could hold the refresh off indefinitely.
      if (busyRef.current) return
      if (document.hidden) return
      loadFleet(shuttleBase, host)
        .then((data) => {
          setFleet(data)
          setDrifted(false)
        })
        // A failed refetch must NOT be swallowed. Every row's "answering · 4s
        // ago" is computed at render from a fixed stamp, so silence here is
        // the page going on asserting a freshness it has stopped knowing
        // about — verbatim the thing this timer was added to prevent. The rows
        // stay (the last good read is still the truest thing we have) and say
        // they have stopped moving.
        .catch(() => setDrifted(true))
    }, FLEET_POLL_MS)
    return () => window.clearInterval(id)
  }, [shuttleBase, host.origin])

  const busyRef = useRef(busy)
  busyRef.current = busy

  const refresh = (): void => {
    setToken((n) => n + 1)
    onChanged()
  }

  const run = async (fn: () => Promise<{ output: string }>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    setSaid(null)
    try {
      const result = await fn()
      setSaid(result.output || 'done')
      refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const managed = (fleet?.remotes ?? []).filter(
    (r) => r.tunnel?.manager && r.tunnel.manager !== 'none',
  )

  return (
    <>
      <p className="set-lede">
        The other shuttle daemons {host.label} aggregates onto its board. Each is reached either
        at a URL outright — a Tailscale address needs no tunnel and survives a closed lid — or
        through a local port this host forwards over SSH. Configured is not the same as
        reachable, and neither is the same as up to date, so each row says all three.
      </p>

      {error && <div className="set-error" role="alert">{error}</div>}
      {fleet?.error && (
        <div className="set-error" role="alert">
          The fleet file would not parse, so this host is running with no remotes at all:
          {'\n'}
          {fleet.error}
        </div>
      )}

      {drifted && fleet !== null && (
        <div className="set-error" role="status">
          These rows have stopped refreshing — the last read of {host.label} failed. The ages
          below are frozen at whenever one last worked, so read them as history rather than as
          now.
        </div>
      )}

      {fleet === null && !error && <div className="set-empty">Reading the fleet…</div>}

      {fleet !== null && fleet.remotes.length === 0 && !fleet.error && (
        <div className="set-empty">
          No remotes — {host.label} is a correct single-machine daemon, serving only its own
          board.
        </div>
      )}

      {fleet !== null && fleet.remotes.length > 0 && (
        <ul className="set-list">
          {fleet.remotes.map((remote) => {
            const h = remote.health
            const breaker = h.recovery && h.recovery.state !== 'healthy' ? h.recovery : null
            return (
              <li className="set-row" key={remote.name}>
                <span className="set-row-main">
                  <span className="set-row-path">
                    {remote.display && remote.display !== remote.name
                      ? `${remote.display} (${remote.name})`
                      : remote.name}
                    {remote.enabled === false && (
                      <span style={{ color: '#7A7068' }}> · disabled</span>
                    )}
                  </span>
                  <span className="set-row-note">{transport(remote)}</span>
                  <span
                    className={`set-row-note${h.stale ? ' set-row-note-owed' : ''}`}
                  >
                    {!h.polled
                      ? 'not polled yet — configured since this daemon last reloaded the file'
                      : h.stale
                        ? `stale · last answered ${ago(h.last_polled_at)}`
                        : `answering · ${ago(h.last_polled_at)}`}
                    {remote.build?.git_short_sha && ` · ${remote.build.git_short_sha}`}
                    {remote.build?.booted_at &&
                      ` · booted ${ago(remote.build.booted_at)}`}
                    {h.polled && !remote.build && ' · build unknown (older daemon)'}
                  </span>
                  {h.last_error && (
                    <span className="set-row-note set-row-note-error">{h.last_error}</span>
                  )}
                  {breaker && (
                    <span className="set-row-note set-row-note-owed">
                      recovery {breaker.state}
                      {breaker.attempt > 0 && ` · attempt ${breaker.attempt}`}
                      {host.isLocal && (
                        <>
                          {' — '}
                          <button
                            type="button"
                            className="set-btn set-btn-drop"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await resetRemote(shuttleBase, remote.name)
                                return { output: `reset the breaker on ${remote.name}` }
                              })
                            }
                          >
                            reset
                          </button>
                        </>
                      )}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className="set-btn set-btn-drop"
                  disabled={busy}
                  title={`Remove ${remote.name} from the fleet file`}
                  aria-label={`Remove ${remote.name}`}
                  onClick={() => void run(() => removeRemote(shuttleBase, host, remote.name))}
                >
                  ✕
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {/* ── Add ─────────────────────────────────────────────────────────── */}

      {!adding ? (
        <div className="set-actions" style={{ marginTop: '16px' }}>
          <button type="button" className="set-btn" onClick={() => setAdding(true)}>
            Add a remote…
          </button>
        </div>
      ) : (
        <>
          <div className="set-section-label">Add a remote</div>
          <div className="set-actions">
            <input
              className="set-input"
              style={{ flex: '1 1 8rem', minWidth: 0 }}
              placeholder="name"
              value={draft.name}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              aria-label="Remote name"
            />
            <input
              className="set-input"
              style={{ flex: '2 1 14rem', minWidth: 0 }}
              placeholder="https://host.example.ts.net"
              value={draft.url}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              aria-label="URL"
            />
          </div>
          <div className="set-actions">
            <input
              className="set-input"
              style={{ flex: '1 1 8rem', minWidth: 0 }}
              placeholder="ssh destination (optional)"
              value={draft.ssh}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => setDraft({ ...draft, ssh: e.target.value })}
              aria-label="SSH destination"
            />
            <input
              className="set-input"
              style={{ flex: '0 1 8rem', minWidth: 0 }}
              placeholder="local port"
              inputMode="numeric"
              value={draft.port}
              onChange={(e) => setDraft({ ...draft, port: e.target.value })}
              aria-label="Local forwarded port"
            />
            <input
              className="set-input"
              style={{ flex: '2 1 12rem', minWidth: 0 }}
              placeholder="checkout path (optional)"
              value={draft.checkout}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => setDraft({ ...draft, checkout: e.target.value })}
              aria-label="Checkout path"
            />
          </div>
          <p className="set-row-note" style={{ marginTop: '6px' }}>
            Give it a <strong>URL</strong> to reach the daemon outright, or a{' '}
            <strong>local port</strong> to forward over SSH — one or the other is required. A
            port also needs an ssh destination, which defaults to the name. Anything the file
            can hold and this form cannot — <span className="set-mono">enabled</span>,{' '}
            <span className="set-mono">ssh_flags</span>,{' '}
            <span className="set-mono">auth</span>, per-remote timeouts — belongs in the file
            below; adding a name that already exists <em>replaces</em> its entry and drops those.
          </p>
          <div className="set-actions">
            <button
              type="button"
              className="set-btn set-btn-primary"
              disabled={busy || draft.name.trim() === ''}
              onClick={() =>
                void run(async () => {
                  const result = await saveRemote(shuttleBase, host, {
                    name: draft.name.trim(),
                    url: draft.url.trim() || undefined,
                    ssh: draft.ssh.trim() || undefined,
                    port: draft.port.trim() || undefined,
                    checkout: draft.checkout.trim() || undefined,
                  })
                  setDraft({ name: '', url: '', ssh: '', port: '', checkout: '' })
                  setAdding(false)
                  return result
                })
              }
            >
              {busy ? 'Adding…' : 'Add'}
            </button>
            <button type="button" className="set-btn" disabled={busy} onClick={() => {
              setDraft({ name: '', url: '', ssh: '', port: '', checkout: '' })
              setAdding(false)
            }}>
              Cancel
            </button>
          </div>
        </>
      )}

      {/* ── Tunnels ─────────────────────────────────────────────────────── */}

      <div className="set-section-label">Tunnels</div>
      {managed.length === 0 ? (
        <p className="set-lede" style={{ marginBottom: 0 }}>
          Nothing here needs one: every remote is reached at a URL. A tunnel is only for a
          remote given a local port to forward.
        </p>
      ) : (
        <>
          <p className="set-lede" style={{ marginBottom: '6px' }}>
            {managed.length} remote{managed.length === 1 ? '' : 's'} forward
            {managed.length === 1 ? 's' : ''} through a supervised{' '}
            <span className="set-mono">autossh</span> job on {host.label} (
            {fleet?.supervisor ?? 'its supervisor'}):{' '}
            <span className="set-mono">
              {managed.map((r) => r.tunnel_label ?? r.name).join(', ')}
            </span>
            . Installing with nothing named is convergent — it writes every job the file asks
            for and removes any it no longer does.
          </p>
          <div className="set-actions">
            <button
              type="button"
              className="set-btn"
              disabled={busy}
              onClick={() => void run(() => runTunnels(shuttleBase, host, 'preview'))}
            >
              Preview
            </button>
            <button
              type="button"
              className="set-btn"
              disabled={busy}
              onClick={() => void run(() => runTunnels(shuttleBase, host, 'install'))}
            >
              Install
            </button>
          </div>
        </>
      )}

      {said && <div className="set-said">{said}</div>}

      <FileEditor
        shuttleBase={shuttleBase}
        host={host}
        id="remotes"
        reloadToken={token}
        onSaved={refresh}
      />
    </>
  )
}
