/**
 * React-island manager for the Stash + Capture forms.
 *
 * The kanban board is vanilla TS/DOM; these two forms are the only React in
 * the app. Rather than mount React at boot, we lazily create one root the
 * first time a form opens and render into it on demand — `openStash` /
 * `openCapture` are imperative entry points the board's header buttons call
 * (`onStashClick` / `onNewIdeaClick`). Only one form is open at a time, so a
 * single shared root suffices; closing renders `null`.
 *
 * Both forms need the "project" set — the map-less replacement for Portolan's
 * pinned cities. The authoritative list comes from `/api/v1/felt-stores`; the
 * composite feed supplies activity/ranking metadata only (see projectModel).
 * Both create endpoints are owner-routed now, so both forms get every
 * registered project: a local origin writes/spawns here, a remote origin
 * forwards to its owning daemon.
 *
 * The store payload also carries the origin list both forms' HOST picker
 * offers, and whether each daemon can raise a native folder dialog
 * (`native_folder_picker`); that flag decides whether "+ Add project…" asks the
 * OS or asks the human to type the path on the selected host.
 */

import { createRoot, type Root } from 'react-dom/client'
import { parseCompositeFeed } from '../board/KanbanComposite.js'
import { deriveProjects, type ProjectModel } from './projectModel'
import { StashForm, injectStashFormStyles, type StashProject } from './StashForm'
import { CaptureForm, type CaptureProject } from './CaptureForm'
import { injectProjectPickerStyles } from './ProjectPicker'

export interface OpenFormOptions {
  /** Shuttle daemon base — `''` (relative) in the standalone bundle. */
  shuttleBase: string
  /** Surface a result (success or failure) to the user, e.g. a board toast. */
  onResult?: (message: string, ok: boolean) => void
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

interface LoadedFeed {
  model: ProjectModel
  tags: string[]
}

async function loadFeed(shuttleBase: string): Promise<LoadedFeed> {
  const [res, storesRes] = await Promise.all([
    fetch(`${shuttleBase}/api/v1/fibers/composite`),
    fetch(`${shuttleBase}/api/v1/felt-stores`).catch(() => null),
  ])
  if (!res.ok) throw new Error(`composite ${res.status}`)
  const json: unknown = await res.json()
  const storesJson: unknown = storesRes?.ok ? await storesRes.json().catch(() => undefined) : undefined
  const model = deriveProjects(json, storesJson)
  const feed = parseCompositeFeed(json)
  const tagSet = new Set<string>()
  for (const e of feed.entries) for (const t of e.fiber.tags ?? []) tagSet.add(t)
  return { model, tags: [...tagSet].sort() }
}

/** The project set both forms consume, in the shape they consume it. Stash's
 *  extra `loomPrefix` rides along harmlessly for Capture. */
function toProjects(model: ProjectModel): StashProject[] {
  return model.projects.map((p) => ({
    id: p.id,
    name: p.name,
    path: p.path,
    originId: p.isLocal ? 'local' : p.originId,
    loomPrefix: p.loomPrefix,
  }))
}

/**
 * Re-derive the project set after a directory was registered through
 * `POST /api/v1/projects`. Deliberately a full reload rather than trusting the
 * POST response's `projects`: `deriveProjects` stays the one place a project's
 * shape (origin, loomPrefix, felt store) is decided, and the added path is a
 * bare string until it has been through it.
 */
async function refreshProjects(shuttleBase: string): Promise<StashProject[]> {
  const feed = await loadFeed(shuttleBase)
  return toProjects(feed.model)
}

export async function openStash(opts: OpenFormOptions): Promise<void> {
  injectStashFormStyles()
  let feed: LoadedFeed
  try {
    feed = await loadFeed(opts.shuttleBase)
  } catch {
    opts.onResult?.('Couldn’t reach the Shuttle daemon (:4000).', false)
    return
  }
  // Create is owner-routed — offer every project; local origin writes here,
  // remote origins forward to their owning daemon.
  const projects: StashProject[] = toProjects(feed.model)

  ensureRoot().render(
    <StashForm
      availableCities={projects}
      availableHosts={feed.model.hosts}
      cityActivityById={feed.model.activityById}
      tagSuggestions={feed.tags}
      shuttleBase={opts.shuttleBase}
      onProjectAdded={() => refreshProjects(opts.shuttleBase)}
      nativeFolderPicker={feed.model.nativeFolderPicker}
      onCancel={close}
      onCreated={(id) => {
        close()
        opts.onResult?.(`Stashed ${id} → Drafts`, true)
      }}
    />,
  )
}

export async function openCapture(opts: OpenFormOptions): Promise<void> {
  // Capture styles its own chrome inline, so the shared pickers' sheet has to
  // be injected here (Stash gets it via injectStashFormStyles).
  injectProjectPickerStyles()
  let feed: LoadedFeed
  try {
    feed = await loadFeed(opts.shuttleBase)
  } catch {
    opts.onResult?.('Couldn’t reach the Shuttle daemon (:4000).', false)
    return
  }
  // Capture is owner-routed — offer every project; local origin routes local,
  // remote origins forward to their owning daemon.
  const projects: CaptureProject[] = toProjects(feed.model)

  ensureRoot().render(
    <CaptureForm
      availableCities={projects}
      availableHosts={feed.model.hosts}
      cityActivityById={feed.model.activityById}
      shuttleBase={opts.shuttleBase}
      onProjectAdded={() => refreshProjects(opts.shuttleBase)}
      nativeFolderPicker={feed.model.nativeFolderPicker}
      onCancel={close}
      onSpawned={(session) => {
        close()
        opts.onResult?.(`Capture session spawned${session ? ` · ${session}` : ''}`, true)
      }}
    />,
  )
}
