/**
 * Host — what this daemon is, and how it is faring. The one section with no
 * file under it, because it edits nothing.
 *
 * It exists because the questions it answers are the ones you have while
 * changing everything else on this page, and every one of them used to need a
 * terminal on that machine: which build is it running, did it boot since I
 * deployed, is the CLI it shells the one it expects, is its poll loop healthy,
 * is it holding fresh launches behind the boot quarantine.
 *
 * ## The host identity is shown and not editable
 *
 * `shuttle.host:` on a fiber is compared for exact equality against this
 * value, so it silently decides whether anything dispatches at all. It is also
 * frozen once per boot into the daemon's process memory. Rewriting the file
 * under a live daemon would change what the CLI thinks this machine is called
 * while leaving the dispatcher on the old answer — the two disagreeing about
 * who this machine is is the worst failure this system has. So it is a fact
 * here, and changing it is a stop-edit-start.
 *
 * ## Releasing a quarantine from here
 *
 * `POST /api/v1/quarantine/release` is owner-routed, so a hub can arm a remote
 * that restarted — which is exactly the case this section is for. It is the
 * one control on this page that is not about configuration at all: it grants
 * dispatch authority, and the sentence beside it says so.
 */

import { useEffect, useState } from 'react'

import {
  loadHostState,
  releaseQuarantine,
  type HostState,
  type SettingsHost,
} from './settingsApi'

export interface HostSectionProps {
  shuttleBase: string
  host: SettingsHost
}

function when(iso: string | undefined): string {
  if (!iso || iso === 'unknown') return 'unknown'
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return iso
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  const rel =
    secs < 60
      ? `${secs}s ago`
      : secs < 3600
        ? `${Math.round(secs / 60)}m ago`
        : secs < 86400
          ? `${Math.round(secs / 3600)}h ago`
          : `${Math.round(secs / 86400)}d ago`
  return `${iso.replace('T', ' ').replace(/\.\d+Z?$/, '')} · ${rel}`
}

export function HostSection({ shuttleBase, host }: HostSectionProps): JSX.Element {
  const [state, setState] = useState<HostState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [token, setToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState(null)
    setError(null)
    loadHostState(shuttleBase, host)
      .then((data) => {
        if (cancelled) return
        if (!data) {
          setError(
            `${host.label} has not answered this hub's poll yet, so there is no state to show.`,
          )
        }
        setState(data)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [shuttleBase, host.origin, token])

  // Live while open, on the board's cadence — the quarantine can be released
  // from elsewhere, a worker can finish, and “booted 2m ago” is computed at
  // render from a fixed stamp. A quiet refetch: failures are dropped rather
  // than replacing what is on screen with an error the last good read
  // disproves.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (busy) return
      loadHostState(shuttleBase, host)
        .then((data) => data && setState(data))
        .catch(() => {})
    }, 15_000)
    return () => window.clearInterval(id)
  }, [shuttleBase, host.origin, busy])

  const build = state?.build
  const contract = state?.contract
  const poll = state?.poll_health
  const cache = state?.document_cache as
    | { state?: string; entries?: number; refreshed_at?: string }
    | undefined

  return (
    <>
      <p className="set-lede">
        What {host.label} is running and how it is faring. None of it is configuration — the
        host identity is frozen at boot and everything else is a reading. The one action here
        is releasing a boot quarantine, and it only appears when there is one.
      </p>

      {error && <div className="set-error" role="alert">{error}</div>}

      {state === null && !error && <div className="set-empty">Reading…</div>}

      {state !== null && (
        <>
          <div className="set-section-label">Identity</div>
          <dl className="set-facts">
            <dt>host id</dt>
            <dd>{state.host ?? host.host}</dd>
            <dt>origin key</dt>
            <dd>{host.isLocal ? '(this daemon)' : host.origin}</dd>
            <dt>stores polled</dt>
            <dd>{(state.felt_stores ?? []).length}</dd>
          </dl>
          <p className="set-row-note" style={{ marginTop: '8px' }}>
            A fiber dispatches on this host only when its{' '}
            <span className="set-mono">shuttle.host:</span> is exactly this id. It comes from{' '}
            <span className="set-mono">SHUTTLE_HOST</span>, else{' '}
            <span className="set-mono">~/.shuttle/host</span>, and the daemon freezes it at boot
            — so changing it means stopping the daemon, editing the file, and starting it again.
          </p>

          <div className="set-section-label">Build</div>
          <dl className="set-facts">
            <dt>commit</dt>
            <dd>{build?.git_short_sha ?? 'unknown'}</dd>
            <dt>built</dt>
            <dd>{when(build?.built_at)}</dd>
            <dt>booted</dt>
            <dd>{when(build?.booted_at)}</dd>
            <dt>release</dt>
            <dd>{build?.mix_vsn ?? 'unknown'}</dd>
          </dl>
          {!build && (
            <p className="set-row-note" style={{ marginTop: '8px' }}>
              This host’s daemon does not report a build stamp — it predates the field. Deploy it
              to see what it is running from here.
            </p>
          )}

          <div className="set-section-label">CLI contract</div>
          <dl className="set-facts">
            <dt>expected</dt>
            <dd>{contract?.expected ?? '—'}</dd>
            <dt>observed</dt>
            <dd>{contract?.observed ?? '—'}</dd>
          </dl>
          {contract && contract.ok === false && (
            <div className="set-error" role="alert">
              This daemon and the felt CLI it shells disagree about the contract level
              {contract.reason ? `: ${contract.reason}` : ''}. Rebuild the CLI on this host —
              daemon-shelled writes fail mid-dispatch when these skew.
            </div>
          )}

          <div className="set-section-label">Work</div>
          <dl className="set-facts">
            <dt>running</dt>
            <dd>
              {state.claimed_count ?? 0} of {state.max_concurrent ?? '—'}
            </dd>
            <dt>standing roles</dt>
            <dd>{(state.standing_roles ?? []).length}</dd>
            <dt>orphans</dt>
            <dd>{(state.orphans ?? []).length}</dd>
            <dt>poll</dt>
            <dd>
              {poll ? `${poll.state}${poll.stalls ? ` · ${poll.stalls} stalls` : ''}` : 'unknown'}
            </dd>
            <dt>document cache</dt>
            <dd>
              {cache ? `${cache.state ?? '—'} · ${cache.entries ?? 0} entries` : 'unknown'}
            </dd>
          </dl>

          {state.boot_quarantine && (
            <>
              <div className="set-section-label">Boot quarantine</div>
              <p className="set-lede" style={{ marginBottom: '6px' }}>
                This daemon restarted and is holding{' '}
                {(state.pending_launch ?? []).length || 'its'} fresh launch
                {(state.pending_launch ?? []).length === 1 ? '' : 'es'} until a human says go —
                a restart is not dispatch authority. Cron-due standing roles still fire.
              </p>
              <div className="set-actions">
                <button
                  type="button"
                  className="set-btn set-btn-primary"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true)
                    setError(null)
                    releaseQuarantine(shuttleBase, host)
                      .then(() => setToken((n) => n + 1))
                      .catch((err: Error) => setError(err.message))
                      .finally(() => setBusy(false))
                  }}
                >
                  {busy ? 'Releasing…' : `Release ${host.isLocal ? '' : host.label}`.trim()}
                </button>
                <span className="set-row-note">
                  the same grant as <span className="set-mono">bin/shuttle release</span> on that
                  machine
                </span>
              </div>
            </>
          )}
        </>
      )}
    </>
  )
}
