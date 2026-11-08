import { useEffect, useState } from 'react'
import { daemonErrorMessage, getDaemonJson, postDaemonJson } from '../../board/daemonApi'
import type { SettingsHost } from './settingsApi'
import { useSettingsDraft } from './SettingsDraftContext'

type Values = { words: number; quiet_seconds: number; pinned_quiet_seconds: number }
const defaults: Values = { words: 200, quiet_seconds: 15, pinned_quiet_seconds: 120 }
const labels: Record<keyof Values, string> = { words: 'Words', quiet_seconds: 'Quiet seconds (following)', pinned_quiet_seconds: 'Quiet seconds (pinned)' }

export function VoiceSection({ shuttleBase, host, onChanged }: { shuttleBase: string; host: SettingsHost; onChanged: () => void }): JSX.Element {
  const [loaded, setLoaded] = useState(false)
  const [values, setValues] = useState<Values>(defaults)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useSettingsDraft('voice', dirty, busy)
  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    void getDaemonJson<Values>(
      `${shuttleBase}/api/v1/voice?recorder=${encodeURIComponent(host.origin)}`, 'Could not read listening settings',
    ).then(body => {
      if (cancelled) return
      setValues({ words: body.words, quiet_seconds: body.quiet_seconds, pinned_quiet_seconds: body.pinned_quiet_seconds })
      setLoaded(true)
    }).catch((err: unknown) => { if (!cancelled) setError(daemonErrorMessage(err)) })
    return () => { cancelled = true }
  }, [shuttleBase, host.origin])
  const save = async (): Promise<void> => {
    setBusy(true); setError(null)
    try {
      await postDaemonJson(shuttleBase, '/api/v1/voice', { ...values, recorder: host.origin }, 'Could not save listening settings')
      setDirty(false); onChanged()
    } catch (err) { setError(daemonErrorMessage(err)) }
    finally { setBusy(false) }
  }
  return <>
    <p className="set-lede">Send speech after this many words or seconds of quiet.</p>
    {error && <div className="set-error" role="alert">{error}</div>}
    {!loaded && !error && <div className="set-empty">Reading…</div>}
    {loaded && <form onSubmit={event => { event.preventDefault(); void save() }}>
      <ul className="set-list">{(['words', 'quiet_seconds', 'pinned_quiet_seconds'] as const).map(field => <li className="set-row" key={field}>
        <label className="set-row-main">{labels[field]}{' '}
          <input className="set-select" type="number" min={field === 'words' ? '1' : '0.001'} step={field === 'words' ? '1' : 'any'} required value={values[field]} onChange={event => {
            setValues({ ...values, [field]: Number(event.target.value) }); setDirty(true)
          }} />
        </label>
      </li>)}</ul>
      <button className="set-btn set-btn-primary" type="submit" disabled={!dirty || busy}>Save</button>
    </form>}
  </>
}
