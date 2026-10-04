import { useEffect, useState } from 'react'
import { claudeOpening, saveClaudeOpening, CONVERSATION_OPENING_CHANGED, type ClaudeOpening } from '../../board/conversationOpening'

const CHOICES: Array<{ id: ClaudeOpening; label: string; note: string }> = [
  { id: 'terminal', label: 'Terminal', note: 'Attach to the worker in Kitty' },
  { id: 'browser', label: 'Claude browser', note: 'Continue through Remote Control' },
  { id: 'app', label: 'Claude app', note: 'Open the installed desktop app' },
]

export function ConversationsSection(): JSX.Element {
  const [choice, setChoice] = useState(claudeOpening)
  const [error, setError] = useState(false)
  useEffect(() => {
    const refresh = (): void => setChoice(claudeOpening())
    window.addEventListener(CONVERSATION_OPENING_CHANGED, refresh)
    return () => window.removeEventListener(CONVERSATION_OPENING_CHANGED, refresh)
  }, [])
  return (
    <>
      <header className="set-pane-heading">
        <h2>Open conversations in</h2>
        <p>Choose what happens when you click Aloft or open a conversation in History.</p>
      </header>
      <fieldset className="set-opening-options">
        <legend className="set-section-label">Default for Claude sessions</legend>
        {CHOICES.map(({ id, label, note }) => (
          <label key={id} className={`set-opening-choice${choice === id ? ' set-opening-selected' : ''}`}>
            <input type="radio" name="claude-opening" value={id} checked={choice === id}
              onChange={() => {
                const saved = saveClaudeOpening(id)
                setError(!saved)
                if (saved) setChoice(id)
              }} />
            <span><strong>{label}</strong><span className="set-opening-note">{note}</span></span>
            {choice === id && <span className="set-opening-default" aria-hidden="true">Default</span>}
          </label>
        ))}
      </fieldset>
      {error && <div className="set-error" role="alert">This browser cannot save preferences. Allow site storage, then try again.</div>}
      <p className="set-opening-guidance">
        {choice === 'terminal'
          ? 'Kitty opens on the machine serving this board. Remote workers need an SSH route.'
          : choice === 'browser'
            ? 'Requires Remote Control in the Claude session. If no link is available, Aloft is labelled terminal and opens Kitty.'
            : 'Requires the Claude desktop app and Remote Control in the session. If an app link is unavailable, Aloft is labelled browser or terminal and opens there.'}
      </p>
      <div className="set-opening-tip"><strong>Choose once, or choose each time.</strong> Right-click Aloft to open a session another way when alternatives are available.</div>
      <p className="set-row-note">Saved in this browser across your fleet. Workers keep running on their assigned hosts.</p>
      <p className="set-row-note">Other terminal workers open in Kitty; Codex app conversations open in ChatGPT. Phones use Claude web links.</p>
      <details className="set-opening-details">
        <summary>Setup and other conversation types</summary>
        <p>Enable Remote Control in Claude Code to get a browser or app link. The installed Claude app can open supported session links; other valid links open in the browser.</p>
        <p>On phones, a Claude web link can open the mobile app.</p>
        <a href="https://cailmdaley.github.io/felt/shuttle/conversations/" target="_blank" rel="noopener noreferrer">Conversation setup guide ↗</a>
      </details>
    </>
  )
}
