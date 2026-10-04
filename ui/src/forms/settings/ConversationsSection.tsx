import { useState } from 'react'
import { claudeOpening, saveClaudeOpening, type ClaudeOpening } from '../../board/conversationOpening'

export function ConversationsSection(): JSX.Element {
  const [choice, setChoice] = useState(claudeOpening)
  const [error, setError] = useState(false)
  return (
    <>
      <p className="set-lede">
        Choose where Aloft and History open Claude conversations. This setting applies
        to this browser across your fleet.
      </p>
      <div className="set-section-label">Open Claude conversations in</div>
      <ul className="set-list">
        <li className="set-row">
          <span className="set-row-main">
            <select className="set-select" aria-label="Open Claude conversations in" value={choice}
              onChange={(event) => {
                const next = event.target.value as ClaudeOpening
                const saved = saveClaudeOpening(next)
                setError(!saved)
                if (saved) setChoice(next)
              }}>
              <option value="terminal">Terminal (Kitty)</option>
              <option value="browser">Claude browser</option>
              <option value="app">Claude app</option>
            </select>
            <p className="set-row-note">
              Browser and app opening require Remote Control enabled in the Claude session.
              If no link is available, the button opens Kitty and is labelled terminal.
              Claude app opening also requires the installed Claude desktop app.
              Links without a supported app route open in the browser instead.
            </p>
            <p className="set-row-note">
              Kitty opens on the machine serving this board; remote workers also need an SSH route.
              Phones use the Claude web link, which can open the mobile app.
              Codex app conversations continue to open in ChatGPT.
            </p>
            <p className="set-row-note">
              <a href="https://cailmdaley.github.io/felt/shuttle/conversations/" target="_blank" rel="noopener noreferrer">Conversation setup and opening options ↗</a>
            </p>
          </span>
        </li>
      </ul>
      {error && <div className="set-error" role="alert">This browser cannot save preferences. Allow site storage, then try again.</div>}
    </>
  )
}
