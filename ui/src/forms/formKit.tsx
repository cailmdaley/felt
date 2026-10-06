/**
 * formKit — the grammar Capture and Stash share inside an AppDialog.
 *
 * Both forms are one column of full-width blocks on a single alignment grid:
 * a lead field (Capture's yap, Stash's title), a four-control row, the
 * dispatch extras, the `--chrome` flag, and a footer under a hairline with the
 * keyboard line on the left and Cancel · submit on the right. Every part of
 * that rhythm lives here, so the two forms are siblings by construction rather
 * than by two style sheets agreeing. What only one form has — the yap and the
 * meeting row, the slug receipt, tags, parent picker and kind segments — stays
 * in that form's own sheet.
 *
 * The type scale: 19px title (AppDialog), 17px for the lead field, 15px for
 * controls, 11px uppercase labels.
 */

import type { ReactNode } from 'react'
import { injectStyles } from './injectStyles'
import { resolveEffort, type AgentEntry } from './agents'
import { sessionHelp, type ExecutionSurface } from './executionSurface'
import { HostPicker, ProjectPicker, injectProjectPickerStyles } from './ProjectPicker'
import type { Host, Project } from './projectModel'

/** A labelled control. `as="label"` when the child is one native control, so a
 *  click on the label focuses it; a `div` when the child is a composite. */
export function Field({
  label,
  optional,
  as: Tag = 'label',
  className,
  children,
}: {
  label: ReactNode
  optional?: boolean
  as?: 'label' | 'div'
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <Tag className={className ? `form-field ${className}` : 'form-field'}>
      <span className="form-label">
        {label}
        {optional && <span className="form-optional">opt</span>}
      </span>
      {children}
    </Tag>
  )
}

/** Host, then project — the pair both forms open their control row with. */
export function HostProjectFields({
  hosts,
  selectedHostId,
  onHostChange,
  projects,
  selectedProjectId,
  onProjectChange,
  onAddProject,
}: {
  hosts: Host[]
  selectedHostId: string | null
  onHostChange: (id: string) => void
  projects: Project[]
  selectedProjectId: string | null
  onProjectChange: (id: string) => void
  onAddProject?: () => void
}): JSX.Element {
  return (
    <>
      <Field label="Host" as="div">
        <HostPicker hosts={hosts} selectedId={selectedHostId} onSelect={onHostChange} className="form-select" />
      </Field>
      <Field label="Project" as="div">
        <ProjectPicker
          projects={projects}
          selectedId={selectedProjectId}
          onSelect={onProjectChange}
          onAddProject={onAddProject}
          className="form-select"
        />
      </Field>
    </>
  )
}

/** The reasoning-effort select, gated on the agent's registry metadata. */
export function EffortField({
  agent,
  effort,
  onChange,
}: {
  agent: AgentEntry | undefined
  effort: string
  onChange: (effort: string) => void
}): JSX.Element {
  const levels = agent?.effort_levels ?? []
  return (
    <Field label="Effort">
      <select
        className="form-select"
        value={resolveEffort(agent, effort)}
        onChange={(e) => onChange(e.target.value)}
        disabled={levels.length === 0}
      >
        {levels.map((lvl) => (
          <option key={lvl} value={lvl}>
            {lvl}
          </option>
        ))}
      </select>
    </Field>
  )
}

/** Where a Codex worker runs — the ChatGPT app or a terminal. Spans the row. */
export function SessionField({
  surface,
  onChange,
}: {
  surface: ExecutionSurface
  onChange: (surface: ExecutionSurface) => void
}): JSX.Element {
  return (
    <Field label="Session" className="form-span">
      <select
        aria-label="Session"
        className="form-select"
        value={surface}
        onChange={(e) => onChange(e.target.value as ExecutionSurface)}
      >
        <option value="app">ChatGPT app</option>
        <option value="cli">Terminal</option>
      </select>
      <span className="form-help">{sessionHelp(surface)}</span>
    </Field>
  )
}

/** The `--chrome` launch flag, offered only when its host and agent support it. */
export function ChromeFlag({
  checked,
  capable,
  onChange,
}: {
  checked: boolean
  capable: boolean
  onChange: (checked: boolean) => void
}): JSX.Element | null {
  if (!capable) return null
  return (
    <label className="form-chrome">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <code>--chrome</code>
      <span className="form-chrome-hint">browser automation mode</span>
    </label>
  )
}

export function FormError({ error }: { error: string | null }): JSX.Element | null {
  if (!error) return null
  return (
    <div className="form-error" role="alert">
      {error}
    </div>
  )
}

/**
 * The footer: the keyboard line, then Cancel and the submit button. `verb` is
 * what ⌘↵ does, in lower case; `tone` is the form's accent — cobalt for a
 * session that starts now, brass for a card filed to wait.
 */
export function FormFoot({
  verb,
  submitLabel,
  submitting,
  disabled,
  tone,
  onCancel,
  onSubmit,
}: {
  verb: string
  submitLabel: string
  submitting: boolean
  disabled: boolean
  tone: 'cobalt' | 'brass'
  onCancel: () => void
  onSubmit: () => void
}): JSX.Element {
  return (
    <div className="form-foot">
      <span className="form-foot-hint">
        <kbd>Esc</kbd> cancel <span className="form-foot-dot">·</span> <kbd>⌘↵</kbd> {verb}
      </span>
      <div className="form-buttons">
        <button type="button" className="form-btn form-cancel" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button
          type="button"
          className={`form-btn form-submit form-submit-${tone}`}
          onClick={onSubmit}
          disabled={disabled}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  )
}

/**
 * Inject the shared sheet, and the pickers' sheet it draws on.
 *
 * Every measurable value the alignment depends on lives here: `.form-sheet`'s
 * children are full-width blocks on one column, and every select shares
 * `.form-select`, so equal boxes are a property of the markup.
 */
export function injectFormKitStyles(): void {
  injectStyles('form-kit-styles', `
    .form-sheet {
      display: flex;
      flex-direction: column;
      gap: 14px;
      font-family: var(--font-main, 'EB Garamond', serif);
      color: var(--kbn-graphite);
    }
    .form-sheet > * {
      box-sizing: border-box;
    }
    /* Four equal grid columns rather than flex children, so the last
       column's right edge is the container's right edge exactly, and a narrow
       card breaks 2×2 instead of stranding one control on its own row. */
    .form-controls {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }
    @media (max-width: 640px) {
      .form-controls {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    .form-span { grid-column: 1 / -1; }
    .form-span-2 { grid-column: span 2; }
    .form-field {
      display: flex;
      flex-direction: column;
      gap: 5px;
      min-width: 0;
    }
    .form-label {
      display: inline-flex;
      align-items: baseline;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--kbn-graphite-soft);
      line-height: 1;
    }
    .form-optional {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 9.5px;
      font-weight: 400;
      letter-spacing: 0.12em;
      color: var(--kbn-graphite-pale);
      padding: 1px 4px;
      border: 1px solid color-mix(in srgb, var(--kbn-graphite) 10%, transparent);
      border-radius: 2px;
    }
    .form-help { font-size: 12px; line-height: 1.4; color: var(--kbn-graphite-muted); }
    /* One rule for every select. Custom chevron, so the boxes are identical
       rather than at the mercy of native select metrics, and border-box
       sizing, so each control fills its track exactly. */
    .form-select,
    .form-input,
    .form-textarea {
      width: 100%;
      box-sizing: border-box;
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 15px;
      line-height: 1.3;
      color: var(--kbn-graphite);
      background-color: var(--kbn-blank);
      border: 1px solid color-mix(in srgb, var(--kbn-graphite) 20%, transparent);
      border-radius: 3px;
      padding: 7px 9px;
      transition: border-color 120ms ease-out, box-shadow 120ms ease-out;
    }
    .form-select {
      appearance: none;
      -webkit-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%237A7068'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 10px center;
      padding-right: 28px;
      cursor: pointer;
    }
    .form-textarea {
      resize: vertical;
      line-height: 1.45;
    }
    .form-input::placeholder,
    .form-textarea::placeholder {
      color: var(--kbn-graphite-faint);
      font-style: italic;
    }
    .form-select:focus,
    .form-input:focus,
    .form-textarea:focus {
      outline: none;
      border-color: var(--kbn-owed-bright);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--kbn-owed) 18%, transparent);
    }
    .form-select:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .form-mono {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 13px;
      letter-spacing: 0.02em;
    }
    .form-hint {
      font-size: 12px;
      color: var(--kbn-graphite-muted);
      font-style: italic;
    }
    .form-hint code {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 11px;
      font-style: normal;
      background: color-mix(in srgb, var(--kbn-graphite) 6%, transparent);
      padding: 1px 5px;
      border-radius: 2px;
    }
    .form-hint-warn {
      color: color-mix(in srgb, var(--kbn-ochre) 85%, var(--kbn-ink));
      font-style: normal;
    }
    .form-chrome {
      display: inline-flex;
      align-items: center;
      align-self: flex-start;
      gap: 8px;
      font-size: 13px;
      color: var(--kbn-graphite);
      cursor: pointer;
      user-select: none;
    }
    .form-chrome input[type="checkbox"] {
      width: 14px;
      height: 14px;
      margin: 0;
      accent-color: var(--kbn-agent);
      cursor: inherit;
    }
    .form-chrome code {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 12px;
      background: color-mix(in srgb, var(--kbn-graphite) 6%, transparent);
      padding: 1px 5px;
      border-radius: 2px;
      color: var(--kbn-agent-deep);
    }
    .form-chrome-hint {
      font-style: italic;
      font-size: 12px;
      color: var(--kbn-graphite-muted);
    }
    .form-error {
      padding: 8px 10px;
      background: color-mix(in srgb, var(--kbn-alarm) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--kbn-alarm) 50%, transparent);
      color: var(--kbn-error);
      font-size: 13px;
      border-radius: 2px;
    }
    .form-foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-top: 2px;
      padding-top: 13px;
      border-top: 1px solid color-mix(in srgb, var(--kbn-graphite) 10%, transparent);
    }
    .form-foot-hint {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      color: var(--kbn-graphite-muted);
    }
    .form-foot-dot {
      color: var(--kbn-graphite-pale);
    }
    .form-foot-hint kbd {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 10px;
      background: color-mix(in srgb, var(--kbn-graphite) 10%, transparent);
      padding: 1px 5px;
      border-radius: 2px;
      border: 1px solid color-mix(in srgb, var(--kbn-graphite) 16%, transparent);
      color: var(--kbn-graphite-deep);
    }
    .form-buttons {
      display: flex;
      gap: 8px;
    }
    .form-btn {
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 15px;
      letter-spacing: 0.01em;
      padding: 6px 18px;
      border-radius: 3px;
      border: 1px solid transparent;
      cursor: pointer;
      transition: background 120ms ease-out, border-color 120ms ease-out;
    }
    .form-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .form-cancel {
      background: transparent;
      color: var(--kbn-graphite-muted);
      border-color: color-mix(in srgb, var(--kbn-graphite) 20%, transparent);
    }
    .form-cancel:hover:not(:disabled) {
      background: color-mix(in srgb, var(--kbn-graphite) 6%, transparent);
      color: var(--kbn-graphite);
    }
    /* Wide enough for "Start meeting", so a longer label leaves Cancel where
       it was. */
    .form-submit {
      min-width: 8em;
      color: var(--kbn-on-pigment);
    }
    /* Cobalt matches the ✶ trigger and the In Flight lane; brass matches the
       + trigger and Drafts. */
    .form-submit-cobalt {
      background: var(--kbn-agent);
      border-color: var(--kbn-agent-deep);
      box-shadow: 0 1px 0 color-mix(in srgb, var(--kbn-rag) 22%, transparent) inset;
    }
    .form-submit-cobalt:hover:not(:disabled) {
      background: color-mix(in srgb, var(--kbn-agent) 90%, var(--kbn-ink));
    }
    .form-submit-brass {
      background: var(--kbn-owed-bright);
      border-color: var(--kbn-owed-dark);
      box-shadow: 0 1px 0 color-mix(in srgb, var(--kbn-rag) 25%, transparent) inset;
    }
    .form-submit-brass:hover:not(:disabled) {
      background: color-mix(in srgb, var(--kbn-owed-bright) 77%, var(--kbn-ink-muted));
    }
  `)
  injectProjectPickerStyles()
}
