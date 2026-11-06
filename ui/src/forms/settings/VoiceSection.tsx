import { useEffect, useState } from 'react'
import { loadConfigFile, saveConfigFile, type SettingsHost } from './settingsApi'
import { useSettingsDraft } from './SettingsDraftContext'

type Values = { enabled: boolean; voice: { words: number; quiet_seconds: number }; meeting: { words: number; quiet_seconds: number } }
const defaults: Values = { enabled: false, voice: { words: 200, quiet_seconds: 15 }, meeting: { words: 150, quiet_seconds: 10 } }

export function VoiceSection({ shuttleBase, host, onChanged }: { shuttleBase: string; host: SettingsHost; onChanged: () => void }): JSX.Element {
  const [doc, setDoc] = useState<Record<string, unknown> | null>(null)
  const [digest, setDigest] = useState<string | null>(null)
  const [values, setValues] = useState<Values>(defaults)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useSettingsDraft('voice', dirty, busy)
  useEffect(() => {
    let cancelled = false
    loadConfigFile(shuttleBase, host, 'voice').then(file => {
      if (cancelled) return
      const parsed = file.text.trim() ? JSON.parse(file.text) as Record<string, unknown> : {}
      const voice = (parsed.voice ?? {}) as Partial<Values['voice']>
      const meeting = (parsed.meeting ?? {}) as Partial<Values['meeting']>
      setDoc(parsed); setDigest(file.digest)
      setValues({ enabled: parsed.enabled === true, voice: { ...defaults.voice, ...voice }, meeting: { ...defaults.meeting, ...meeting } })
    }).catch((err: Error) => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [shuttleBase, host.origin])
  const save = async (): Promise<void> => {
    if (!doc) return
    setBusy(true); setError(null)
    try {
      const next = { ...doc, enabled: values.enabled, voice: { ...doc.voice as object, ...values.voice }, meeting: { ...doc.meeting as object, ...values.meeting } }
      const file = await saveConfigFile(shuttleBase, host, 'voice', JSON.stringify(next, null, 2) + '\n', digest)
      setDoc(next); setDigest(file.digest); setDirty(false); onChanged()
      if (host.isLocal) window.dispatchEvent(new CustomEvent('shuttle-voice-settings-saved', { detail: values.enabled }))
    } catch (err) { setError((err as Error).message) }
    finally { setBusy(false) }
  }
  return <>
    <p className="set-lede">Voice and meetings send speech after this many words or seconds of quiet.</p>
    {error && <div className="set-error" role="alert">{error}</div>}
    {!doc && !error && <div className="set-empty">Reading…</div>}
    {doc && <form onSubmit={event => { event.preventDefault(); void save() }}>
      <label><input type="checkbox" checked={values.enabled} onChange={event => { setValues({ ...values, enabled: event.target.checked }); setDirty(true) }} /> Voice on</label>
      {(['voice', 'meeting'] as const).map(kind => <div key={kind}>
        <div className="set-section-label">{kind === 'voice' ? 'Voice' : 'Meetings'}</div>
        <ul className="set-list">{(['words', 'quiet_seconds'] as const).map(field => <li className="set-row" key={field}>
          <label className="set-row-main">{field === 'words' ? 'Words' : 'Quiet seconds'}{' '}
            <input className="set-select" type="number" min={field === 'words' ? '1' : '0.001'} step={field === 'words' ? '1' : 'any'} required value={values[kind][field]} onChange={event => {
              setValues({ ...values, [kind]: { ...values[kind], [field]: Number(event.target.value) } }); setDirty(true)
            }} />
          </label>
        </li>)}</ul>
      </div>)}
      <button className="set-btn set-btn-primary" type="submit" disabled={!dirty || busy}>Save</button>
    </form>}
  </>
}
