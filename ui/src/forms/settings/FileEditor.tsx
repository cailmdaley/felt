/**
 * The file a section is a form for, editable as text.
 *
 * Every section on this page ends with one of these, folded shut. The
 * structured controls above it are the ordinary path; this is what makes the
 * page's claim to hold *all* the configuration true rather than "all the
 * configuration we built a widget for". Three things it is the only way to do:
 *
 *   - reach a key no CLI flag can set (`remotes.json` carries `auth`,
 *     `ssh_flags`, `tunnel.label` and per-entry timeouts; `felt shuttle remotes
 *     add` has a flag for none of them),
 *   - see what is actually on disk, rather than a model's opinion of it,
 *   - edit a file this page has no form for at all, from a phone.
 *
 * It is also the SAFE way to touch `remotes.json`. A structured round trip —
 * parse, edit the model, re-encode — silently drops every key the model does
 * not know about; a text edit cannot, because nothing re-encodes anything.
 *
 * Saving posts the whole text to `POST /api/v1/config/:id`, which refuses it
 * unless the tool that really reads that file accepts it first. A refusal
 * arrives as that tool's own sentence and is shown verbatim: felt says which
 * remote and which port, and no paraphrase improves on that.
 */

import { useEffect, useRef, useState } from 'react'

import {
  CONFIG_FILENAME,
  isConflict,
  loadConfigFile,
  saveConfigFile,
  type ConfigId,
  type SettingsHost,
} from './settingsApi'

export interface FileEditorProps {
  shuttleBase: string
  host: SettingsHost
  id: ConfigId
  /** Bumped by the parent when a structured edit rewrote the file underneath. */
  reloadToken: number
  /** The structured half should refresh — a save here changed what it reads. */
  onSaved: () => void
}

export function FileEditor({
  shuttleBase,
  host,
  id,
  reloadToken,
  onSaved,
}: FileEditorProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState<{
    text: string
    path: string
    exists: boolean
    digest: string | null
  } | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [conflict, setConflict] = useState(false)
  /** The draft differs from the bytes on disk as we last saw them. */
  const dirty = loaded !== null && draft !== loaded.text

  /**
   * Re-read the file.
   *
   * `keepDraft` is for the one case where re-reading is a RESPONSE to your own
   * edit rather than a replacement for it: the save was refused because the
   * file moved underneath, and throwing away what you typed in order to show
   * you what it moved to would be the worse of the two losses. The box keeps
   * your text, `dirty` recomputes against the new base, and saving again now
   * carries the new digest.
   */
  // Every read is stamped, and one whose stamp is no longer current is dropped
  // on arrival. The parent also remounts this component on a host switch,
  // which would hide the problem — but "one host's file rendered under another
  // host's name" is the one unacceptable state on this page, and it should not
  // rest on a `key` attribute in a different file staying correct.
  const generation = useRef(0)
  const load = useRef<(keepDraft?: boolean) => void>(() => {})
  load.current = (keepDraft?: boolean): void => {
    setError(null)
    const mine = ++generation.current
    loadConfigFile(shuttleBase, host, id)
      .then((file) => {
        if (mine !== generation.current) return
        setLoaded({
          text: file.text,
          path: file.path,
          exists: file.exists,
          digest: file.digest ?? null,
        })
        if (!keepDraft) setDraft(file.text)
      })
      .catch((err: Error) => {
        if (mine === generation.current) setError(err.message)
      })
  }

  // Fetch only once opened: four sections' files would otherwise be four
  // requests per host switch for text nobody is looking at.
  useEffect(() => {
    if (!open) return
    load.current()
  }, [open, host.origin, id, reloadToken])

  // A host switch invalidates everything shown here, including the fold: the
  // next host's file is a different file, and leaving the previous one's text
  // on screen under a new host's name is the one mistake this page must not
  // make.
  useEffect(() => {
    generation.current += 1
    setLoaded(null)
    setDraft('')
    setError(null)
    setSaved(false)
  }, [host.origin, id])

  const save = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const file = await saveConfigFile(shuttleBase, host, id, draft, loaded?.digest ?? null)
      setConflict(false)
      setLoaded({
        text: file.text,
        path: file.path,
        exists: file.exists,
        digest: file.digest ?? null,
      })
      setDraft(file.text)
      setSaved(true)
      onSaved()
    } catch (err) {
      // Whether this refusal was a CONFLICT decides whether the recovery
      // affordance appears, and that must not be a substring test on the
      // daemon's prose — reword the message and the button would vanish with
      // nothing going red. The API layer reports the kind; this reads the kind.
      setConflict(isConflict(err))
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const filename = CONFIG_FILENAME[id]

  return (
    <details
      className="set-file"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        {filename}
        {dirty && <span style={{ color: '#9A7B35' }}>· unsaved</span>}
      </summary>

      {open && (
        <>
          <div className={`set-file-path${loaded && !loaded.exists ? ' set-file-absent' : ''}`}>
            {loaded
              ? loaded.exists
                ? loaded.path
                : `${loaded.path} — no such file yet; saving creates it`
              : 'reading…'}
          </div>

          <textarea
            className="set-textarea"
            rows={16}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={draft}
            disabled={loaded === null}
            onChange={(e) => {
              setDraft(e.target.value)
              setSaved(false)
            }}
            aria-label={`${filename} on ${host.label}`}
          />

          <div className="set-actions">
            <button
              type="button"
              className="set-btn set-btn-primary"
              disabled={busy || loaded === null || !dirty}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : draft.trim() === '' ? 'Delete file' : 'Save'}
            </button>
            <button
              type="button"
              className="set-btn"
              disabled={busy || loaded === null || !dirty}
              onClick={() => {
                setDraft(loaded?.text ?? '')
                setError(null)
              }}
            >
              Revert
            </button>
            <span className="set-actions-spacer" />
            {saved && !dirty && <span className="set-row-note">saved</span>}
            {draft.trim() === '' && loaded?.exists && (
              <span className="set-row-note set-row-note-owed">
                empty removes the file
              </span>
            )}
          </div>

          {error && (
            <div className="set-error" role="alert">
              {error}
              {conflict && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="set-btn set-btn-drop"
                    onClick={() => load.current(true)}
                  >
                    check what it says now
                  </button>
                  {' — your text stays in the box; Revert swaps it for theirs.'}
                </>
              )}
            </div>
          )}
        </>
      )}
    </details>
  )
}
