import { useEffect, useState } from 'react'
import { conversationDevice, conversationOpening, resolveDestination, saveConversationOpening, CONVERSATION_OPENING_CHANGED, type ConversationOpening } from '../../board/conversationOpening'

type Choice = { id: ConversationOpening; label: string; note: string }
const TERMINAL: Choice = { id: 'terminal', label: 'Terminal', note: 'Rex on Rex hosts; the daemon terminal opener elsewhere' }
const BROWSER: Choice = { id: 'browser', label: 'Claude browser', note: 'Continue through Remote Control' }
const APP: Choice = { id: 'app', label: 'Claude app', note: 'Open the installed desktop app' }

/** The preference is per browser, so it offers only what this device can open,
 *  in the order opening falls back through them. */
export function deviceChoices(desktop: boolean): Choice[] {
  return desktop ? [TERMINAL, BROWSER, APP] : [BROWSER]
}

export function ConversationsSection(): JSX.Element {
  const choices = deviceChoices(conversationDevice().desktop)
  const [stored, setChoice] = useState(conversationOpening)
  const choice = resolveDestination(choices, stored)?.id
  const [error, setError] = useState(false)
  useEffect(() => {
    const refresh = (): void => setChoice(conversationOpening())
    window.addEventListener(CONVERSATION_OPENING_CHANGED, refresh)
    return () => window.removeEventListener(CONVERSATION_OPENING_CHANGED, refresh)
  }, [])
  return (
    <>
      <header className="set-pane-heading">
        <h2>Open conversations in</h2>
        <p>Console, worker pills, keyboard opening and History share this preference.</p>
      </header>
      <fieldset className="set-opening-options">
        <legend className="set-section-label">Preferred destination</legend>
        {choices.map(({ id, label, note }) => (
          <label key={id} className={`set-opening-choice${choice === id ? ' set-opening-selected' : ''}`}>
            <input type="radio" name="claude-opening" value={id} checked={choice === id}
              onChange={() => {
                const saved = saveConversationOpening(id)
                setError(!saved)
                if (saved) setChoice(id)
              }} />
            <span><strong>{label}</strong><span className="set-opening-note">{note}</span></span>
            {choice === id && <span className="set-opening-default" aria-hidden="true">Default</span>}
          </label>
        ))}
      </fieldset>
      {error && <div className="set-error" role="alert">This browser cannot save preferences. Allow site storage, then try again.</div>}
      <p className="set-opening-guidance">If your preferred destination is unavailable for a worker or device, opening uses the best available one: terminal on desktop, Claude browser, or ChatGPT for Codex app workers.</p>
      <div className="set-opening-tip"><strong>Tap to open. Hold to choose.</strong> Long-press or right-click Console or a worker pill to see its destinations. Choosing opens it and, when there are alternatives, remembers it. A sole destination leaves your preference unchanged.</div>
      <p className="set-row-note">Saved in this browser across your fleet. Workers keep running on their assigned hosts.</p>
      <details className="set-opening-details">
        <summary>Conversation setup</summary>
        <p>Enable Remote Control in Claude Code to get a browser or app link. The installed Claude desktop app can open supported session links.</p>
        <p>Phones can use Claude web links for CLI workers. A worker without a phone destination has no Console button.</p>
        <a href="https://cailmdaley.github.io/felt/shuttle/conversations/" target="_blank" rel="noopener noreferrer">Conversation setup guide ↗</a>
      </details>
    </>
  )
}
