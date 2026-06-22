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
 * pinned cities, derived from the composite feed (see projectModel). Both
 * create endpoints are owner-routed now, so both forms get every project: a
 * local origin writes/spawns here, a remote origin forwards to its owning
 * daemon.
 */

import { createRoot, type Root } from 'react-dom/client'
import { parseCompositeFeed } from '../board/KanbanComposite.js'
import { deriveProjects, type ProjectModel } from './projectModel'
import { StashForm, injectStashFormStyles, type StashProject } from './StashForm'
import { CaptureForm } from './CaptureForm'

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
  const res = await fetch(`${shuttleBase}/api/v1/fibers/composite`)
  if (!res.ok) throw new Error(`composite ${res.status}`)
  const json: unknown = await res.json()
  const model = deriveProjects(json)
  const feed = parseCompositeFeed(json)
  const tagSet = new Set<string>()
  for (const e of feed.entries) for (const t of e.fiber.tags ?? []) tagSet.add(t)
  return { model, tags: [...tagSet].sort() }
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
  const projects: StashProject[] = feed.model.projects.map((p) => ({
    id: p.id,
    name: p.name,
    path: p.path,
    originId: p.isLocal ? 'local' : p.originId,
    loomPrefix: p.loomPrefix,
  }))

  ensureRoot().render(
    <StashForm
      availableCities={projects}
      cityActivityById={feed.model.activityById}
      tagSuggestions={feed.tags}
      shuttleBase={opts.shuttleBase}
      onCancel={close}
      onCreated={(id) => {
        close()
        opts.onResult?.(`Stashed ${id} → Drafts`, true)
      }}
    />,
  )
}

export async function openCapture(opts: OpenFormOptions): Promise<void> {
  let feed: LoadedFeed
  try {
    feed = await loadFeed(opts.shuttleBase)
  } catch {
    opts.onResult?.('Couldn’t reach the Shuttle daemon (:4000).', false)
    return
  }
  // Capture is owner-routed — offer every project; local origin routes local,
  // remote origins forward to their owning daemon.
  const projects = feed.model.projects.map((p) => ({
    id: p.id,
    name: p.name,
    path: p.path,
    originId: p.isLocal ? 'local' : p.originId,
  }))

  ensureRoot().render(
    <CaptureForm
      availableCities={projects}
      cityActivityById={feed.model.activityById}
      shuttleBase={opts.shuttleBase}
      onCancel={close}
      onSpawned={(session) => {
        close()
        opts.onResult?.(`Capture session spawned${session ? ` · ${session}` : ''}`, true)
      }}
    />,
  )
}
