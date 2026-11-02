import { useEffect, useState } from 'react'
import { conversationOpening, saveConversationOpening, CONVERSATION_OPENING_CHANGED, type ConversationOpening } from '../../board/conversationOpening'

const CHOICES: Array<{ id: ConversationOpening; label: string; note: string }> = [
  { id: 'terminal', label: 'Terminal', note: 'Rex on Rex hosts; the daemon terminal opener elsewhere' },
  { id: 'browser', label: 'Claude browser', note: 'Continue through Remote Control' },
  { id: 'app', label: 'Claude app', note: 'Open the installed desktop app' },
  { id: 'chatgpt', label: 'ChatGPT', note: 'Continue a Codex app conversation' },
  { id: 'rex', label: 'Rex on phone', note: 'Open Rex, then choose the constitution family’s session' },
]

export function ConversationsSection(): JSX.Element {
  const [choice, setChoice] = useState(conversationOpening)
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
        {CHOICES.map(({ id, label, note }) => (
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
      <p className="set-opening-guidance">If your preferred destination is unavailable for a worker or device, opening uses the best available one: terminal on desktop, Rex on phone for Rex workers, Claude browser, or ChatGPT for Codex app workers.</p>
      <div className="set-opening-tip"><strong>Tap to open. Hold to choose.</strong> Long-press or right-click Console or a worker pill to see its destinations. Choosing one opens it and remembers it.</div>
      <p className="set-row-note">Saved in this browser across your fleet. Workers keep running on their assigned hosts.</p>
      <details className="set-opening-details">
        <summary>Conversation setup</summary>
        <p>Enable Remote Control in Claude Code to get a browser or app link. The installed Claude desktop app can open supported session links.</p>
        <p>Phones can open Rex for CLI workers on Rex hosts, or use Claude web links. A worker without a phone destination has no Console button.</p>
        <a href="https://cailmdaley.github.io/felt/shuttle/conversations/" target="_blank" rel="noopener noreferrer">Conversation setup guide ↗</a>
      </details>
    </>
  )
}
