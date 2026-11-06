import { useEffect, useState } from 'react'
import { loadConfigFile, saveConfigFile, type SettingsHost } from './settingsApi'
import { useSettingsDraft } from './SettingsDraftContext'

type Values = { words: number; quiet_seconds: number; cold_minutes: number }
const defaults: Values = { words: 200, quiet_seconds: 15, cold_minutes: 5 }

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
      const voice = (parsed.voice ?? {}) as Partial<Values>
      const meeting = (parsed.meeting ?? {}) as Partial<Values>
      setDoc(parsed); setDigest(file.digest)
      setValues({
        words: (parsed.words as number | undefined) ?? voice.words ?? meeting.words ?? defaults.words,
        quiet_seconds: (parsed.quiet_seconds as number | undefined) ?? voice.quiet_seconds ?? meeting.quiet_seconds ?? defaults.quiet_seconds,
        cold_minutes: (parsed.cold_minutes as number | undefined) ?? defaults.cold_minutes,
      })
    }).catch((err: Error) => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [shuttleBase, host.origin])
  const save = async (): Promise<void> => {
    if (!doc) return
    setBusy(true); setError(null)
    try {
      const { voice: _voice, meeting: _meeting, ...rest } = doc
      const next = { ...rest, ...values }
      const file = await saveConfigFile(shuttleBase, host, 'voice', JSON.stringify(next, null, 2) + '\n', digest)
      setDoc(next); setDigest(file.digest); setDirty(false); onChanged()
    } catch (err) { setError((err as Error).message) }
    finally { setBusy(false) }
  }
  return <>
    <p className="set-lede">Send speech after this many words or seconds of quiet.</p>
    {error && <div className="set-error" role="alert">{error}</div>}
    {!doc && !error && <div className="set-empty">Reading…</div>}
    {doc && <form onSubmit={event => { event.preventDefault(); void save() }}>
      <ul className="set-list">{(['words', 'quiet_seconds', 'cold_minutes'] as const).map(field => <li className="set-row" key={field}>
        <label className="set-row-main">{field === 'words' ? 'Words' : field === 'quiet_seconds' ? 'Quiet seconds' : 'Cold-worker minutes'}{' '}
          <input className="set-select" type="number" min={field === 'words' ? '1' : '0.001'} step={field === 'words' ? '1' : 'any'} required value={values[field]} onChange={event => {
            setValues({ ...values, [field]: Number(event.target.value) }); setDirty(true)
          }} />
        </label>
      </li>)}</ul>
      <button className="set-btn set-btn-primary" type="submit" disabled={!dirty || busy}>Save</button>
    </form>}
  </>
}
