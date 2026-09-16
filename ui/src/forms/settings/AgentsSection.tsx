/**
 * Agents — the registry this host resolves `shuttle.agent:` against, shown as
 * the merged table and edited as the file.
 *
 * The registry is two layers: a built-in fleet embedded in the felt binary,
 * and this host's `agents.json` folded over it. The table below shows the
 * RESULT, with each row's layer marked, because that is the only view that
 * answers the question anyone actually has — "what happens if I write
 * `agent: x`". A table of just the user file would show three records on a
 * host that can run seventeen.
 *
 * There is no form for a record, and that is a decision rather than an
 * omission. The merge is wholesale by id — a user record REPLACES a built-in
 * one rather than patching it — so a form offering one field at a time would
 * be quietly lying about what saving it does. The file is the honest editor,
 * and it is validated by the loader that reads it for real, which fails on an
 * unsupported version or an unknown `builtins` mode and warns about a dangling
 * alias.
 *
 * `felt shuttle agents init` seeds that file from the built-ins — a worked
 * example of every field, ready to edit. The lede says so, because the empty
 * textarea below is otherwise a poor place to start from.
 */

import { useEffect, useState } from 'react'

import { FileEditor } from './FileEditor'
import { loadAgents, type AgentRecord, type ConfigFileSummary, type SettingsHost } from './settingsApi'

export interface AgentsSectionProps {
  shuttleBase: string
  host: SettingsHost
  summary: ConfigFileSummary | undefined
  onChanged: () => void
}

export function AgentsSection({
  shuttleBase,
  host,
  summary,
  onChanged,
}: AgentsSectionProps): JSX.Element {
  const [agents, setAgents] = useState<AgentRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    setAgents(null)
    setError(null)
    loadAgents(shuttleBase, host)
      .then((rows) => {
        if (!cancelled) setAgents(Array.isArray(rows) ? rows : [])
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [shuttleBase, host.origin, token])

  const base = (agents ?? []).filter((a) => !a.alias_of)
  const aliases = (agents ?? []).filter((a) => a.alias_of)
  const userCount = base.filter((a) => a.source === 'user').length

  return (
    <>
      <p className="set-lede">
        What <span className="set-mono">shuttle.agent:</span> resolves to on {host.label} — the
        fleet built into its felt binary, with its own{' '}
        <span className="set-mono">agents.json</span> folded over the top by id. A user record
        replaces a built-in one <em>wholesale</em>; set{' '}
        <span className="set-mono">"builtins": "restrict"</span> in the file to drop the shipped
        layer altogether. Run <span className="set-mono">felt shuttle agents init</span> on that
        host to seed the file with a worked example of every field.
      </p>

      {error && <div className="set-error" role="alert">{error}</div>}

      {agents === null && !error && <div className="set-empty">Reading the registry…</div>}

      {agents !== null && base.length === 0 && !error && (
        <div className="set-empty">
          No agents resolve on this host — nothing here can dispatch. A malformed{' '}
          <span className="set-mono">agents.json</span> reads this way too; the file below will
          say so when you save it.
        </div>
      )}

      {base.length > 0 && (
        <>
          <div className="set-section-label">
            {base.length} agent{base.length === 1 ? '' : 's'}
            {userCount > 0 && ` · ${userCount} from this host’s file`}
          </div>
          <ul className="set-list">
            {base.map((agent) => (
              <li className="set-row" key={agent.id}>
                <span className="set-row-main">
                  <span className="set-row-path">
                    {agent.id}
                    {agent.default && (
                      <span style={{ color: '#9A7B35' }}> · default</span>
                    )}
                    {agent.source === 'user' && (
                      <span style={{ color: '#7A7068' }}> · from file</span>
                    )}
                  </span>
                  <span className="set-row-note">
                    {[
                      agent.cli,
                      agent.provider,
                      agent.model,
                      agent.effort_levels?.length
                        ? `effort ${agent.effort_levels.join('/')}${
                            agent.default_effort ? ` (${agent.default_effort})` : ''
                          }`
                        : 'no effort axis',
                      agent.chrome_capable ? 'chrome' : null,
                      agent.cost_class,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {aliases.length > 0 && (
        <p className="set-row-note" style={{ marginTop: '8px' }}>
          Aliases:{' '}
          <span className="set-mono">
            {aliases.map((a) => `${a.id} → ${a.alias_of}`).join(', ')}
          </span>
        </p>
      )}

      {summary && !summary.exists && (
        <p className="set-row-note" style={{ marginTop: '10px' }}>
          {host.label} has no <span className="set-mono">agents.json</span> — everything above is
          the shipped layer.
        </p>
      )}

      <FileEditor
        shuttleBase={shuttleBase}
        host={host}
        id="agents"
        reloadToken={token}
        onSaved={() => {
          setToken((n) => n + 1)
          onChanged()
        }}
      />
    </>
  )
}
