/**
 * React-island manager for the Stash, Capture and Settings sheets.
 *
 * The kanban board is vanilla TS/DOM; these sheets are the only React in the
 * app. Rather than mount React at boot, we lazily create one root the first
 * time one opens and render into it on demand — `openStash` / `openCapture` /
 * `openSettings` are imperative entry points the board's chrome calls
 * (`onStashClick` / `onNewIdeaClick` / `onSettingsClick`). Only one is open at
 * a time, so a single shared root suffices; closing renders `null`.
 *
 * Both forms need the host and project sets (see projectModel). The
 * authoritative list comes from `/api/v1/felt-stores`; the composite feed
 * supplies recency and the loom prefix. Both create endpoints are
 * owner-routed, so both forms get every registered project: a local origin
 * writes/spawns here, a remote origin forwards to its owning daemon.
 *
 * The store payload also carries the origin list both forms' HOST picker
 * offers, and whether each daemon can raise a native folder dialog
 * (`native_folder_picker`); that flag decides whether "+ Add project…" asks the
 * OS or asks the human to type the path on the selected host.
 */

import { createRoot, type Root } from 'react-dom/client'
import { loadFeed, type LoadedFeed } from './projectFeed'
import type { Project } from './projectModel'
import { StashForm, injectStashFormStyles } from './StashForm'
import { CaptureForm, injectCaptureFormStyles } from './CaptureForm'
import { SettingsDialog } from './settings/SettingsDialog'
import { loadHosts } from './settings/settingsApi'

export interface OpenFormOptions {
  /** Shuttle daemon base — `''` (relative) in the standalone bundle. */
  shuttleBase: string
  /** Surface a result (success or failure) to the user, e.g. a board toast. */
  onResult?: (message: string, ok: boolean) => void
  /** Meeting recording outcomes distinguish a continuing recording from failure. */
  onMeetingResult?: (message: string, tone: 'success' | 'warning') => void
  /** Refresh the local meeting row as soon as recording is confirmed. */
  onMeetingStarted?: () => void
}

let container: HTMLElement | null = null
let root: Root | null = null

function ensureRoot(): Root {
  if (!root) {
    container = document.createElement('div')
    container.id = 'shuttle-forms-root'
    document.body.appendChild(container)
    root = createRoot(container)
  }
  return root
}

function close(): void {
  root?.render(null)
}

/**
 * Re-derive the project set after a directory was registered through
 * `POST /api/v1/projects`. A full reload rather than trusting the POST
 * response's `projects`: `deriveProjects` stays the one place a project's
 * shape (origin, loomPrefix, felt store) is decided, and the added path is a
 * bare string until it has been through it.
 */
async function refreshProjects(shuttleBase: string): Promise<Project[]> {
  return (await loadFeed(shuttleBase)).model.projects
}

/** The feed a form opens on, or null after telling the board it is out of reach. */
async function feedOrReport(opts: OpenFormOptions): Promise<LoadedFeed | null> {
  try {
    return await loadFeed(opts.shuttleBase)
  } catch {
    opts.onResult?.('Couldn’t reach the Shuttle daemon (:4000).', false)
    return null
  }
}

export async function openStash(opts: OpenFormOptions): Promise<void> {
  injectStashFormStyles()
  const feed = await feedOrReport(opts)
  if (!feed) return
  ensureRoot().render(
    <StashForm
      projects={feed.model.projects}
      hosts={feed.model.hosts}
      tagSuggestions={feed.tags}
      shuttleBase={opts.shuttleBase}
      onProjectAdded={() => refreshProjects(opts.shuttleBase)}
      onCancel={close}
      onCreated={(id) => {
        close()
        opts.onResult?.(`Stashed ${id} → Drafts`, true)
      }}
    />,
  )
}

export async function openCapture(opts: OpenFormOptions): Promise<void> {
  injectCaptureFormStyles()
  const feed = await feedOrReport(opts)
  if (!feed) return
  ensureRoot().render(
    <CaptureForm
      projects={feed.model.projects}
      hosts={feed.model.hosts}
      shuttleBase={opts.shuttleBase}
      onProjectAdded={() => refreshProjects(opts.shuttleBase)}
      onCancel={close}
      onSpawned={({ tmuxSession: session, surface }) => {
        close()
        opts.onResult?.(surface === 'app' ? 'Codex run started in ChatGPT' : `Capture session spawned${session ? ` · ${session}` : ''}`, true)
      }}
      onMeetingResult={({ host, error }) => {
        close()
        opts.onMeetingStarted?.()
        const tone = error ? 'warning' : 'success'
        const message = error ?? `Recording started; the scribe is starting on ${host}.`
        if (opts.onMeetingResult) opts.onMeetingResult(message, tone)
        else opts.onResult?.(message, tone === 'success')
      }}
    />,
  )
}

/**
 * Open the settings sheet.
 *
 * It loads the fleet's hosts BEFORE rendering, for the same reason the other
 * two load the project feed first: a sheet that opens on a spinner and then
 * decides which machine it is about is a sheet you can start typing into
 * before it knows where the typing goes. Settings writes configuration to a
 * host, so it opens already knowing which.
 */
export async function openSettings(opts: OpenFormOptions): Promise<void> {
  let hosts
  try {
    hosts = await loadHosts(opts.shuttleBase)
  } catch (err) {
    opts.onResult?.((err as Error).message, false)
    return
  }
  ensureRoot().render(
    <SettingsDialog shuttleBase={opts.shuttleBase} hosts={hosts} onClose={close} />,
  )
}
