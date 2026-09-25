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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { AppDialog } from '../AppDialog'
import { SettingsDraftContext } from './SettingsDraftContext'
import { AgentsSection } from './AgentsSection'
import { FleetSection } from './FleetSection'
import { HostClassSection } from './HostClassSection'
import { HostSection } from './HostSection'
import { PathListSection } from './PathListSection'
import { injectSettingsStyles } from './settingsStyles'
import {
  loadConfigIndex,
  loadHosts,
  type ConfigFileSummary,
  type SettingsHost,
} from './settingsApi'

type SectionId = 'stores' | 'projects' | 'agents' | 'fleet' | 'hostClass' | 'host'

const SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: 'stores', label: 'Stores' },
  { id: 'projects', label: 'Projects' },
  { id: 'agents', label: 'Agents' },
  { id: 'fleet', label: 'Fleet' },
  { id: 'hostClass', label: 'Host class' },
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
  const drafts = useRef(new Set<string>())
  const writes = useRef(new Set<string>())
  const [waitingForWrite, setWaitingForWrite] = useState(false)
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null)
  const trackDraft = useCallback((id: string, dirty: boolean, busy: boolean): void => {
    if (busy) writes.current.add(id)
    else writes.current.delete(id)
    if (!writes.current.size) setWaitingForWrite(false)
    if (dirty) drafts.current.add(id)
    else drafts.current.delete(id)
    if (!drafts.current.size) setPendingNavigation(null)
  }, [])
  const navigate = (action: () => void): void => {
    if (writes.current.size) { setWaitingForWrite(true); return }
    if (drafts.current.size) setPendingNavigation(() => action)
    else {
      setPendingNavigation(null)
      action()
    }
  }
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent): void => {
      if (!drafts.current.size && !writes.current.size) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
  // Bumped whenever something under this host changed on disk. Everything that
  // reads the host's own lists keys off it, so a save in the file editor is
  // visible in the rows above it without a reopen.
  const [revision, setRevision] = useState(0)
  const [liveHosts, setLiveHosts] = useState(hosts)
  /**
   * The config index, STAMPED with the host it describes.
   *
   * Stamped rather than bare, because clearing it in an effect is one render
   * too late: the first paint after a host switch still held the previous
   * host's rows, and a section that latched an environment-override flag out
   * of that paint carried one machine's warning onto another's page. A stamp
   * makes the staleness unrepresentable instead of racing to erase it.
   */
  const [index, setIndex] = useState<{ origin: string; files: ConfigFileSummary[] } | null>(null)

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
    // Deliberately NOT cleared first on a revision bump. The index carries the
    // environment-override flag a section uses to disable editing, and a blank
    // index reads as "not overridden" — so clearing it here blinked those
    // controls back on for the length of a round trip, which is the one moment
    // they were guarding against. A host switch does clear it, below.
    const origin = host.origin
    loadConfigIndex(shuttleBase, host)
      .then((data) => {
        if (!cancelled) setIndex({ origin, files: data.files ?? [] })
      })
      .catch(() => {
        // A host too old for the settings API, or unreachable. Every section
        // surfaces that failure in its own terms; the index is only an
        // annotation and its absence should not blank the page.
        if (!cancelled) setIndex({ origin, files: [] })
      })
    return () => {
      cancelled = true
    }
  }, [shuttleBase, host?.origin, revision])

  // Undefined for a host the index is not about — including for the render
  // immediately after a switch, which is the one that used to leak.
  const summaryFor = (id: ConfigFileSummary['id']): ConfigFileSummary | undefined =>
    index && host && index.origin === host.origin
      ? index.files.find((f) => f.id === id)
      : undefined

  const changed = (): void => setRevision((n) => n + 1)

  if (!host) {
    return (
      <AppDialog open onOpenChange={(next) => !next && navigate(onClose)} title="Settings" eyebrow="shuttle">
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
      onOpenChange={(next) => !next && navigate(onClose)}
      title="Settings"
      eyebrow={`shuttle · ${host.label}`}
      wide
      flush
    >
      <SettingsDraftContext.Provider value={trackDraft}>
      <div className="set-page">
        <div className="set-hostbar">
          <span className="set-hostbar-label">Configuring</span>
          <select
            className="set-select"
            value={host.origin}
            onChange={(e) => {
              const next = e.target.value
              navigate(() => setOriginKey(next))
            }}
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
          <button type="button" className="set-btn set-done" onClick={() => navigate(onClose)}>Done</button>
        </div>

        {waitingForWrite && <div className="set-discard" role="status">Saving changes… Wait for this write to finish before leaving.</div>}
        {pendingNavigation && (
          <div className="set-discard" role="alert">
            <span>You have unsaved edits on {host.label}.</span>
            <button type="button" className="set-btn set-btn-primary" onClick={() => setPendingNavigation(null)}>Keep editing</button>
            <button type="button" className="set-btn" onClick={() => {
              if (writes.current.size) { setWaitingForWrite(true); return }
              drafts.current.clear()
              setPendingNavigation(null)
              pendingNavigation()
            }}>Discard edits</button>
          </div>
        )}
        <div className="set-cols">
          <nav className="set-rail" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`set-railbtn${s.id === section ? ' set-railbtn-active' : ''}`}
                aria-current={s.id === section ? 'page' : undefined}
                onClick={() => { if (s.id !== section) navigate(() => setSection(s.id)) }}
              >
                {s.label}
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
            {section === 'hostClass' && (
              <HostClassSection
                shuttleBase={shuttleBase}
                host={host}
                summary={summaryFor('host')}
                onChanged={changed}
              />
            )}
            {section === 'host' && <HostSection shuttleBase={shuttleBase} host={host} />}
          </div>
        </div>
      </div>
      </SettingsDraftContext.Provider>
    </AppDialog>
  )
}
