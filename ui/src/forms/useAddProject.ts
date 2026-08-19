/**
 * "+ Add project…", native-first — the one flow behind both project pickers
 * (Stash's combobox row, Capture's "+ Add" button).
 *
 * The order of preference, decided before the human clicks:
 *
 *   1. **Native.** Local origin + a daemon that reported `native_folder_picker`
 *      → `POST /api/v1/choose-folder` raises the host's own Finder/GTK/KDE
 *      dialog. No overlay: the OS window IS the picker. The fetch blocks until
 *      the human answers, so `busy` is on for the duration.
 *   2. **Browse.** Remote origin, a daemon with no dialog, or a native attempt
 *      that came back unavailable → the `DirectoryPicker` overlay over
 *      `GET /api/v1/browse`. Automatic, never a second button.
 *
 * Cancelling the native dialog is silent — no overlay, no toast, nothing
 * selected. That is the whole point of asking the OS: "no" costs one keystroke.
 *
 * A native pick that the daemon then refuses to register (a permission error,
 * say) falls into the overlay opened AT that path, where the error has a place
 * to be shown rather than being swallowed.
 */

import { useCallback, useState } from 'react'
import { chooseFolder, registerProject } from './chooseFolder'

interface AddProjectOptions<P> {
  shuttleBase: string
  /** The local daemon can raise an OS dialog (from `/api/v1/felt-stores`). */
  nativeFolderPicker: boolean
  /** Origin the picker is currently pointed at — native only for `'local'`. */
  origin: string
  /** Register + re-derive, island-side. Absent → no add affordance at all. */
  onProjectAdded?: (path: string) => Promise<P[]>
  /** Adopt the refreshed set and select the added path. */
  onAdded: (projects: P[], path: string) => void
}

export interface AddProjectFlow {
  /** The picker's "+ Add project…" handler. */
  begin: () => void
  /** A native dialog is open on the daemon's host. Not surfaced — the forms
   *  deliberately show nothing while the human is in the OS dialog — but it
   *  keeps a second click from raising a second one. */
  busy: boolean
  /** Render the `DirectoryPicker` overlay (fallback path only). */
  browseOpen: boolean
  /** Where the overlay should open — a refused native pick, else the default. */
  browsePath: string | undefined
  closeBrowse: () => void
  /** The overlay's `onAdded`. */
  finish: (path: string) => Promise<void>
}

export function useAddProject<P>({
  shuttleBase,
  nativeFolderPicker,
  origin,
  onProjectAdded,
  onAdded,
}: AddProjectOptions<P>): AddProjectFlow {
  const [busy, setBusy] = useState(false)
  const [browseOpen, setBrowseOpen] = useState(false)
  const [browsePath, setBrowsePath] = useState<string | undefined>(undefined)

  const finish = useCallback(
    async (path: string): Promise<void> => {
      if (!onProjectAdded) return
      onAdded(await onProjectAdded(path), path)
      setBrowseOpen(false)
    },
    [onProjectAdded, onAdded],
  )

  const openBrowse = useCallback((path?: string): void => {
    setBrowsePath(path)
    setBrowseOpen(true)
  }, [])

  const begin = useCallback((): void => {
    if (!onProjectAdded || busy) return
    if (!nativeFolderPicker || origin !== 'local') {
      openBrowse()
      return
    }
    setBusy(true)
    void (async () => {
      try {
        const chosen = await chooseFolder(shuttleBase)
        if (chosen.status === 'cancelled') return
        if (chosen.status === 'unavailable') {
          openBrowse()
          return
        }
        if (await registerProject(shuttleBase, chosen.path)) await finish(chosen.path)
        else openBrowse(chosen.path)
      } finally {
        setBusy(false)
      }
    })()
  }, [busy, nativeFolderPicker, origin, onProjectAdded, openBrowse, shuttleBase, finish])

  const closeBrowse = useCallback(() => setBrowseOpen(false), [])

  return { begin, busy, browseOpen, browsePath, closeBrowse, finish }
}
