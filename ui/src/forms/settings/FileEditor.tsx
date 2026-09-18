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
import { useSettingsDraft } from './SettingsDraftContext'

import {
  CONFIG_FILENAME,
  isConflict,
  isUnavailable,
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
  readOnlyReason?: string
}

export function FileEditor({
  shuttleBase,
  host,
  id,
  reloadToken,
  onSaved,
  readOnlyReason,
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
  /** The host could not RUN the check. Nothing is known about what was sent. */
  const [unavailable, setUnavailable] = useState(false)
  /** The draft differs from the bytes on disk as we last saw them. */
  const dirty = loaded !== null && draft !== loaded.text

  useSettingsDraft(id, dirty, busy)

  // Reads and writes belong to one file identity. Late responses from a
  // previous host, or from before a save, cannot replace its successor.
  const generation = useRef(0)
  const current = useRef({ dirty, busy })
  current.current = { dirty, busy }
  const [reading, setReading] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  const load = useRef<(keepDraft?: boolean) => void>(() => {})
  load.current = (keepDraft = false): void => {
    if (current.current.busy || (!keepDraft && current.current.dirty)) return
    setError(null)
    setReading(true)
    const mine = ++generation.current
    loadConfigFile(shuttleBase, host, id)
      .then((file) => {
        if (mine !== generation.current) return
        // Typing may have started while this automatic refresh was in flight.
        if (!keepDraft && current.current.dirty) return
        setLoaded(file)
        if (!keepDraft) setDraft(file.text)
        setConflict(false)
        setUnavailable(false)
        setReviewed(keepDraft)
      })
      .catch((err: Error) => {
        if (mine === generation.current) setError(err.message)
      })
      .finally(() => {
        if (mine === generation.current) setReading(false)
      })
  }

  useEffect(() => {
    generation.current += 1
    current.current = { dirty: false, busy: false }
    setLoaded(null)
    setDraft('')
    setError(null)
    setSaved(false)
    setConflict(false)
    setUnavailable(false)
    setReviewed(false)
    setBusy(false)
    setReading(false)
    return () => { generation.current += 1 }
  }, [shuttleBase, host.origin, id])

  // Folding and structured edits never replace unsaved text. A later save
  // still carries its original digest, so a concurrent disk change conflicts.
  useEffect(() => {
    if (open) load.current()
  }, [open, shuttleBase, host.origin, id, reloadToken])

  const save = async (): Promise<void> => {
    if (busy || reading || readOnlyReason || !loaded || !dirty || conflict) return
    const mine = ++generation.current
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const file = await saveConfigFile(shuttleBase, host, id, draft, loaded?.digest ?? null)
      if (mine !== generation.current) return
      setConflict(false)
      setUnavailable(false)
      setReviewed(false)
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
      if (mine !== generation.current) return
      // Whether this refusal was a CONFLICT decides whether the recovery
      // affordance appears, and that must not be a substring test on the
      // daemon's prose — reword the message and the button would vanish with
      // nothing going red. The API layer reports the kind; this reads the kind.
      setConflict(isConflict(err))
      setUnavailable(isUnavailable(err))
      setError((err as Error).message)
    } finally {
      if (mine === generation.current) setBusy(false)
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
                : `${loaded.path} — ${readOnlyReason ? 'file does not exist' : 'saving creates this file'}`
              : 'reading…'}
          </div>

          {readOnlyReason && <p className="set-said">{readOnlyReason}</p>}

          <textarea
            className="set-textarea"
            rows={16}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={draft}
            disabled={loaded === null}
            readOnly={busy || !!readOnlyReason}
            aria-busy={busy || reading}
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
              disabled={busy || reading || loaded === null || !dirty || !!readOnlyReason || conflict}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : draft.trim() === '' ? 'Delete file' : 'Save changes'}
            </button>
            <button
              type="button"
              className="set-btn"
              disabled={busy || loaded === null || !dirty}
              onClick={() => {
                setDraft(loaded?.text ?? '')
                setError(null)
                setConflict(false)
                setUnavailable(false)
                setReviewed(false)
                setSaved(false)
                current.current.dirty = false
                load.current()
              }}
            >
              Discard changes
            </button>
            <span className="set-actions-spacer" />
            {saved && !dirty && <span className="set-row-note">saved</span>}
            {!readOnlyReason && draft.trim() === '' && loaded?.exists && (
              <span className="set-row-note set-row-note-owed">
                empty removes the file
              </span>
            )}
          </div>

          {reviewed && dirty && (
            <div className="set-said" role="status">
              Your draft is preserved. Compare it with the current file below before saving;
              saving replaces that file with your draft.
              <details>
                <summary>Current file on disk</summary>
                <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{loaded?.text || '(empty)'}</pre>
              </details>
            </div>
          )}

          {error && (
            <div className={unavailable ? 'set-said' : 'set-error'} role="alert">
              {/* A 503 is not a refusal of what you wrote: the host could not
                  run the check at all, so nothing is known about the bytes and
                  nothing you retype will help. Putting it in the red box that
                  means "your JSON is wrong" is the exact conflation the daemon
                  half of this was built to end. */}
              {error}
              {!loaded && (
                <button type="button" className="set-btn" disabled={reading} onClick={() => load.current()}>
                  {reading ? 'Reading…' : 'Try again'}
                </button>
              )}
              {conflict && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="set-btn set-btn-drop"
                    disabled={reading || busy}
                    onClick={() => load.current(true)}
                  >
                    {reading ? 'Reading…' : 'Review current file'}
                  </button>
                  {' Your draft stays in the editor.'}
                </>
              )}
            </div>
          )}
        </>
      )}
    </details>
  )
}
