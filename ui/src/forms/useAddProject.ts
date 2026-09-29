/**
 * "+ Add project…" — the one flow behind both project pickers, in two cases,
 * decided by the host chosen before the click:
 *
 *   1. **Native.** Local host + a daemon that reported `native_folder_picker`
 *      → `POST /api/v1/choose-folder` raises the host's own Finder/GTK/KDE
 *      dialog. No overlay: the OS window IS the picker. The fetch blocks until
 *      the human answers, so `busy` is on for the duration.
 *   2. **Type the path.** Any remote host, or a local daemon with no dialog to
 *      raise → the add row reveals a text input for the absolute path on that
 *      host, POSTed to the owner-routed `POST /api/v1/projects` so the owning
 *      daemon does the felt-init and the registration.
 *
 * Cancelling the native dialog is silent — no row, no toast, nothing selected.
 * That is the whole point of asking the OS: "no" costs one keystroke. A native
 * pick the daemon then refuses to register opens the path row with that
 * refusal, where a corrected path can be typed.
 */

import { useCallback, useState } from 'react'
import { chooseFolder, registerProject } from './chooseFolder'

interface AddProjectOptions<P> {
  shuttleBase: string
  /** The selected host is the local daemon's own and can raise an OS dialog
   *  (its `native_folder_picker` from `/api/v1/felt-stores`). A remote's
   *  dialog would open on a desktop nobody is sitting at. */
  nativeFolderPicker: boolean
  /** Host id the add targets — `'local'` or a bare remote name. Rides along as
   *  `origin` on the owner-routed create. */
  origin: string
  /** Register + re-derive, island-side. Absent → no add affordance at all. */
  onProjectAdded?: (path: string) => Promise<P[]>
  /** Adopt the refreshed set and select the added path. */
  onAdded: (projects: P[], path: string) => void
}

export interface AddProjectFlow {
  /** The picker's "+ Add project…" handler. */
  begin: () => void
  /** A native dialog is open, or a registration is in flight. Not surfaced
   *  while the human is in the OS dialog — but it keeps a second click from
   *  raising a second one. */
  busy: boolean
  /** Render the path-entry row (case 2, and a refused native pick). */
  pathOpen: boolean
  /** The daemon's refusal, verbatim — shown inline in the row. */
  pathError: string | null
  closePath: () => void
  /** The row's submit: register the typed path, then re-derive and select. */
  submitPath: (path: string) => void
}

export function useAddProject<P>({
  shuttleBase,
  nativeFolderPicker,
  origin,
  onProjectAdded,
  onAdded,
}: AddProjectOptions<P>): AddProjectFlow {
  const [busy, setBusy] = useState(false)
  const [pathOpen, setPathOpen] = useState(false)
  const [pathError, setPathError] = useState<string | null>(null)

  const adopt = useCallback(
    async (path: string): Promise<void> => {
      if (!onProjectAdded) return
      onAdded(await onProjectAdded(path), path)
      setPathOpen(false)
      setPathError(null)
    },
    [onProjectAdded, onAdded],
  )

  const openPath = useCallback((error?: string): void => {
    setPathError(error ?? null)
    setPathOpen(true)
  }, [])

  const begin = useCallback((): void => {
    if (!onProjectAdded || busy) return
    if (!nativeFolderPicker) {
      openPath()
      return
    }
    setBusy(true)
    void (async () => {
      try {
        const chosen = await chooseFolder(shuttleBase)
        if (chosen.status === 'cancelled') return
        if (chosen.status === 'unavailable') {
          openPath()
          return
        }
        const registered = await registerProject(shuttleBase, chosen.path, origin)
        if (registered.ok) await adopt(chosen.path)
        else openPath(registered.error)
      } finally {
        setBusy(false)
      }
    })()
  }, [busy, nativeFolderPicker, origin, onProjectAdded, openPath, shuttleBase, adopt])

  const submitPath = useCallback(
    (path: string): void => {
      if (!onProjectAdded || busy) return
      setBusy(true)
      setPathError(null)
      void (async () => {
        try {
          const registered = await registerProject(shuttleBase, path, origin)
          if (registered.ok) await adopt(path)
          else setPathError(registered.error)
        } finally {
          setBusy(false)
        }
      })()
    },
    [busy, onProjectAdded, origin, shuttleBase, adopt],
  )

  const closePath = useCallback(() => {
    setPathOpen(false)
    setPathError(null)
  }, [])

  return { begin, busy, pathOpen, pathError, closePath, submitPath }
}
