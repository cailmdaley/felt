/**
 * The settings sheet: one surface, five sections, any host in the fleet.
 *
 * ## Why an overlay and not a sixth tab
 *
 * The board's five tabs are windows onto the work — the Desk, three time
 * windows, and the shelf of what the work produced. Configuration is not work,
 * and giving it a tab would say it was. It is a sheet you open, change
 * something in, and dismiss, which is what `⌘,` has meant for thirty years.
 *
 * ## Why a host picker is the first control
 *
 * Because the alternative is dangerous. The board became reachable from a
 * phone and from a second hub, and the whole point of putting settings on it
 * is to configure the machine you are not sitting at. Every read and every
 * write below the host bar is addressed to the host named in it, and a page
 * that could write one machine's configuration onto another without saying
 * which is a page that eventually will. So the host is chosen before anything
 * else, it is visible from every section, and it is the key on every request.
 *
 * ## Layout
 *
 * A rail of sections beside a pane, under a band naming the host. On a phone
 * the rail becomes a scrolling strip of chips and the whole sheet is the
 * screen — the same reframing the Desk makes at the same threshold.
 */

import { useEffect, useMemo, useState } from 'react'

import { AppDialog } from '../AppDialog'
import { AgentsSection } from './AgentsSection'
import { FleetSection } from './FleetSection'
import { HostSection } from './HostSection'
import { PathListSection } from './PathListSection'
import { injectSettingsStyles } from './settingsStyles'
import {
  loadConfigIndex,
  loadHosts,
  type ConfigFileSummary,
  type SettingsHost,
} from './settingsApi'

type SectionId = 'stores' | 'projects' | 'agents' | 'fleet' | 'host'

const SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: 'stores', label: 'Stores' },
  { id: 'projects', label: 'Projects' },
  { id: 'agents', label: 'Agents' },
  { id: 'fleet', label: 'Fleet' },
  { id: 'host', label: 'Host' },
]

export interface SettingsDialogProps {
  shuttleBase: string
  /** Every host the page can point at, local first — loaded before the dialog
   *  mounts, so the sheet opens on a real host rather than on a spinner. */
  hosts: SettingsHost[]
  onClose: () => void
}

export function SettingsDialog({
  shuttleBase,
  hosts,
  onClose,
}: SettingsDialogProps): JSX.Element {
  injectSettingsStyles()

  const [originKey, setOriginKey] = useState(hosts[0]?.origin ?? '')
  const [section, setSection] = useState<SectionId>('stores')
  // Bumped whenever something under this host changed on disk. Everything that
  // reads the host's own lists keys off it, so a save in the file editor is
  // visible in the rows above it without a reopen.
  const [revision, setRevision] = useState(0)
  const [liveHosts, setLiveHosts] = useState(hosts)
  const [index, setIndex] = useState<ConfigFileSummary[] | null>(null)

  const host = useMemo(
    () => liveHosts.find((h) => h.origin === originKey) ?? liveHosts[0],
    [liveHosts, originKey],
  )

  // Re-read the origins feed after a write, so the store and project rows
  // reflect what the host now holds rather than what it held on open.
  useEffect(() => {
    if (revision === 0) return
    let cancelled = false
    loadHosts(shuttleBase)
      .then((rows) => {
        if (!cancelled && rows.length) setLiveHosts(rows)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [shuttleBase, revision])

  // The config index carries each file's path and whether an environment
  // variable is overriding it — the one thing a section cannot discover from
  // its own data, and the one that decides whether editing it does anything.
  useEffect(() => {
    if (!host) return
    let cancelled = false
    setIndex(null)
    loadConfigIndex(shuttleBase, host)
      .then((data) => {
        if (!cancelled) setIndex(data.files ?? [])
      })
      .catch(() => {
        // A host too old for the settings API, or unreachable. Every section
        // surfaces that failure in its own terms; the index is only an
        // annotation and its absence should not blank the page.
        if (!cancelled) setIndex([])
      })
    return () => {
      cancelled = true
    }
  }, [shuttleBase, host?.origin, revision])

  const summaryFor = (id: ConfigFileSummary['id']): ConfigFileSummary | undefined =>
    index?.find((f) => f.id === id)

  const changed = (): void => setRevision((n) => n + 1)

  if (!host) {
    return (
      <AppDialog open onOpenChange={(next) => !next && onClose()} title="Settings" eyebrow="shuttle">
        <div className="set-empty">
          This daemon reports no hosts at all — not even itself. It is probably not answering;
          check that it is running.
        </div>
      </AppDialog>
    )
  }

  return (
    <AppDialog
      open
      onOpenChange={(next) => !next && onClose()}
      title="Settings"
      eyebrow={`shuttle · ${host.label}`}
      wide
      flush
    >
      <div className="set-page">
        <div className="set-hostbar">
          <span className="set-hostbar-label">Configuring</span>
          <select
            className="set-select"
            value={host.origin}
            onChange={(e) => setOriginKey(e.target.value)}
            aria-label="Which host to configure"
          >
            {liveHosts.map((h) => (
              <option key={h.origin || '(local)'} value={h.origin}>
                {h.label}
                {h.isLocal ? ' — this host' : ''}
                {h.stale ? ' (stale)' : ''}
              </option>
            ))}
          </select>
          <span className={`set-hostbar-note${host.stale ? ' set-hostbar-stale' : ''}`}>
            {host.isLocal
              ? 'the daemon serving this page'
              : host.stale
                ? 'not answering this hub’s poll — reads and writes may time out'
                : 'reached through this hub'}
          </span>
        </div>

        <div className="set-cols">
          <nav className="set-rail" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`set-railbtn${s.id === section ? ' set-railbtn-active' : ''}`}
                aria-current={s.id === section ? 'page' : undefined}
                onClick={() => setSection(s.id)}
              >
                {s.label}
                {s.id === 'stores' && (
                  <span className="set-railbtn-count">{host.feltStores.length}</span>
                )}
                {s.id === 'projects' && (
                  <span className="set-railbtn-count">{host.projects.length}</span>
                )}
              </button>
            ))}
          </nav>

          {/* Keyed on host + section: switching either replaces the pane
              outright rather than feeding new props to a component still
              holding the previous host's draft text. On this page that is a
              correctness rule, not a performance one. */}
          <div className="set-pane" key={`${host.origin}:${section}`}>
            {section === 'stores' && (
              <PathListSection
                shuttleBase={shuttleBase}
                host={host}
                kind="stores"
                summary={summaryFor('stores')}
                onChanged={changed}
              />
            )}
            {section === 'projects' && (
              <PathListSection
                shuttleBase={shuttleBase}
                host={host}
                kind="projects"
                summary={summaryFor('projects')}
                onChanged={changed}
              />
            )}
            {section === 'agents' && (
              <AgentsSection
                shuttleBase={shuttleBase}
                host={host}
                summary={summaryFor('agents')}
                onChanged={changed}
              />
            )}
            {section === 'fleet' && (
              <FleetSection shuttleBase={shuttleBase} host={host} onChanged={changed} />
            )}
            {section === 'host' && <HostSection shuttleBase={shuttleBase} host={host} />}
          </div>
        </div>
      </div>
    </AppDialog>
  )
}
