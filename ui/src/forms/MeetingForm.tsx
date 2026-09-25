import { useEffect, useRef, useState } from 'react'
import { AppDialog } from './AppDialog'
import {
  AddProjectPath,
  HostPicker,
  ProjectPicker,
  injectProjectPickerStyles,
  type PickerHost,
  type ProjectWithLoomPrefix,
  useProjectSelection,
} from './ProjectPicker'
import { ParentPicker, injectParentPickerStyles } from './ParentPicker'
import { startMeeting, MeetingValidationError, validateMeetingInput, type MeetingField, type MeetingInputErrors, type MeetingMode } from './meetingApi'
import type { MeetingRecord } from '../board/meeting'

export interface MeetingFormProps {
  availableCities: ProjectWithLoomPrefix[]
  availableHosts: PickerHost[]
  cityActivityById?: Record<string, number>
  shuttleBase?: string
  nativeFolderPicker?: boolean
  onProjectAdded?: (path: string) => Promise<ProjectWithLoomPrefix[]>
  onStarted: (meeting: MeetingRecord) => void
  onCancel: () => void
}

export function MeetingForm({
  availableCities,
  availableHosts,
  cityActivityById = {},
  shuttleBase = '',
  nativeFolderPicker = false,
  onProjectAdded,
  onStarted,
  onCancel,
}: MeetingFormProps): JSX.Element {
  const {
    hosts,
    selectedHostId,
    selectedHost,
    handleHostChange,
    hostCities,
    selectedCityId,
    setSelectedCityId,
    selectedCity,
    addProject,
  } = useProjectSelection<ProjectWithLoomPrefix>({
    shuttleBase,
    availableCities,
    availableHosts,
    cityActivityById,
    onProjectAdded,
    nativeFolderPicker,
  })
  const [title, setTitle] = useState('')
  const [under, setUnder] = useState(selectedCity?.loomPrefix ?? '')
  const [mode, setMode] = useState<MeetingMode>('call')
  const [fieldErrors, setFieldErrors] = useState<MeetingInputErrors>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const titleRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  useEffect(() => {
    setUnder(selectedCity?.loomPrefix ?? '')
    setFieldErrors((current) => ({ ...current, under: undefined, projectDir: undefined }))
  }, [selectedCity?.id, selectedCity?.loomPrefix])

  const clearFieldError = (field: MeetingField): void => {
    setFieldErrors((current) => ({ ...current, [field]: undefined }))
    setServerError(null)
  }

  const submit = async (): Promise<void> => {
    if (submitting) return
    const input = {
      title,
      host: selectedHostId,
      projectDir: selectedCity?.path ?? '',
      under,
      mode,
    }
    const errors = validateMeetingInput(input)
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors)
      setServerError(null)
      if (errors.title) titleRef.current?.focus()
      return
    }

    setSubmitting(true)
    setFieldErrors({})
    setServerError(null)
    try {
      const meeting = await startMeeting(shuttleBase, input)
      setSubmitting(false)
      onStarted(meeting)
    } catch (error) {
      if (error instanceof MeetingValidationError) {
        setFieldErrors(error.fields)
      } else {
        const message = (error as { message?: string })?.message ?? String(error)
        setServerError(message.includes('fetch') ? 'Couldn’t reach the Shuttle daemon (:4000).' : message)
      }
      setSubmitting(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (!e.defaultPrevented && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void submit()
    }
  }

  const fieldError = (field: MeetingField): string | undefined => fieldErrors[field]

  return (
    <AppDialog
      open
      onOpenChange={(open) => { if (!open) onCancel() }}
      title="Start a meeting"
      eyebrow="shuttle · hark"
    >
      <div className="meeting-form" onKeyDown={handleKeyDown}>
        <p className="meeting-intro">The scribe runs with the selected project on its host.</p>

        <label className="meeting-field">
          <span className="meeting-label">Title</span>
          <input
            ref={titleRef}
            className={`meeting-input meeting-title${fieldError('title') ? ' meeting-invalid' : ''}`}
            value={title}
            onChange={(e) => { setTitle(e.target.value); clearFieldError('title') }}
            placeholder="Shear telecon"
            autoComplete="off"
            aria-invalid={!!fieldError('title')}
            aria-describedby={fieldError('title') ? 'meeting-title-error' : undefined}
          />
          {fieldError('title') && <span id="meeting-title-error" className="meeting-field-error">{fieldError('title')}</span>}
        </label>

        <div className="meeting-grid">
          <label className="meeting-field">
            <span className="meeting-label">Host</span>
            <HostPicker
              hosts={hosts}
              selectedId={selectedHostId}
              onSelect={(id) => { handleHostChange(id); clearFieldError('host') }}
              className={`meeting-select${fieldError('host') ? ' meeting-invalid' : ''}`}
            />
            {fieldError('host') && <span className="meeting-field-error">{fieldError('host')}</span>}
          </label>
          <label className="meeting-field">
            <span className="meeting-label">Project</span>
            <ProjectPicker
              projects={hostCities}
              selectedId={selectedCityId}
              onSelect={(id) => { setSelectedCityId(id); clearFieldError('projectDir') }}
              onAddProject={onProjectAdded ? addProject.begin : undefined}
              className={`meeting-select${fieldError('projectDir') ? ' meeting-invalid' : ''}`}
            />
            {fieldError('projectDir') && <span className="meeting-field-error">{fieldError('projectDir')}</span>}
          </label>
        </div>

        {addProject.pathOpen && onProjectAdded && (
          <AddProjectPath
            hostLabel={selectedHost.label}
            busy={addProject.busy}
            error={addProject.pathError}
            onSubmit={addProject.submitPath}
            onCancel={addProject.closePath}
          />
        )}

        <label className="meeting-field">
          <span className="meeting-label">Parent fiber</span>
          <ParentPicker
            value={under}
            onChange={(value) => { setUnder(value); clearFieldError('under') }}
            scopePrefix={selectedCity?.loomPrefix ?? ''}
            shuttleBase={shuttleBase}
            idMode="loom-relative"
            inputClassName={`meeting-input meeting-parent${fieldError('under') ? ' meeting-invalid' : ''}`}
            placeholder="work/project  ·  parent-fiber"
          />
          <span className="meeting-hint">Loom-relative id; defaults to this project’s root fiber.</span>
          {fieldError('under') && <span className="meeting-field-error">{fieldError('under')}</span>}
        </label>

        <fieldset className="meeting-mode-field">
          <legend className="meeting-label">Mode</legend>
          <div className="meeting-mode" role="radiogroup" aria-label="Meeting mode">
            {([
              ['call', 'Call', 'Microphone + call audio'],
              ['room', 'Room', 'Room capture'],
            ] as const).map(([value, label, hint]) => (
              <label key={value} className={`meeting-mode-option${mode === value ? ' meeting-mode-selected' : ''}`}>
                <input
                  type="radio"
                  name="meeting-mode"
                  value={value}
                  checked={mode === value}
                  onChange={() => { setMode(value); clearFieldError('mode') }}
                />
                <span className="meeting-mode-name">{label}</span>
                <span className="meeting-mode-hint">{hint}</span>
              </label>
            ))}
          </div>
          {fieldError('mode') && <span className="meeting-field-error">{fieldError('mode')}</span>}
        </fieldset>

        {serverError && <div className="meeting-error" role="alert">{serverError}</div>}

        <div className="meeting-foot">
          <span className="meeting-foot-hint"><kbd>Esc</kbd> cancel <span>·</span> <kbd>⌘↵</kbd> start</span>
          <div className="meeting-buttons">
            <button type="button" className="meeting-btn meeting-cancel" onClick={onCancel} disabled={submitting}>Cancel</button>
            <button type="button" className="meeting-btn meeting-submit" onClick={() => void submit()} disabled={submitting}>
              {submitting ? 'Starting…' : 'Start meeting'}
            </button>
          </div>
        </div>
      </div>
    </AppDialog>
  )
}

export function injectMeetingFormStyles(): void {
  if (typeof document !== 'undefined' && !document.getElementById('meeting-form-styles')) {
    const style = document.createElement('style')
    style.id = 'meeting-form-styles'
    style.textContent = `
      .meeting-form {
        display: flex;
        flex-direction: column;
        gap: 14px;
        min-height: 0;
        color: #2E2A26;
      }
      .meeting-intro { margin: 0; color: #756B60; font-size: 14px; font-style: italic; }
      .meeting-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
      .meeting-label {
        padding: 0;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #5C544D;
      }
      .meeting-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .meeting-input,
      .meeting-select {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid rgba(46, 42, 38, 0.20);
        border-radius: 3px;
        background-color: #FFFFFF;
        color: #2E2A26;
        font-family: var(--font-main, 'EB Garamond', serif);
        font-size: 15px;
        line-height: 1.3;
        padding: 7px 9px;
        transition: border-color 120ms ease-out, box-shadow 120ms ease-out;
      }
      .meeting-title { font-size: 17px; padding: 8px 10px; }
      .meeting-select {
        appearance: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%237A7068'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 10px center;
        padding-right: 28px;
        cursor: pointer;
      }
      .meeting-input:focus, .meeting-select:focus {
        outline: none;
        border-color: #C49333;
        box-shadow: 0 0 0 2px rgba(154, 123, 53, 0.18);
      }
      .meeting-input::placeholder { color: #9A8E80; font-style: italic; }
      .meeting-hint { color: #7A7068; font-size: 12px; font-style: italic; }
      .meeting-invalid { border-color: #B24E3C; }
      .meeting-field-error { color: #8B3A28; font-size: 12px; }
      .meeting-mode-field { border: 0; margin: 0; padding: 0; min-width: 0; }
      .meeting-mode-field > legend { margin-bottom: 5px; }
      .meeting-mode { display: grid; grid-template-columns: 1fr 1fr; gap: 0; padding: 3px; border: 1px solid rgba(46, 42, 38, 0.20); border-radius: 3px; background: #FFFFFF; }
      .meeting-mode-option { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 7px 10px; border-radius: 2px; cursor: pointer; color: #5C544D; }
      .meeting-mode-option input { position: absolute; opacity: 0; pointer-events: none; }
      .meeting-mode-option:hover { background: rgba(154, 123, 53, 0.08); }
      .meeting-mode-selected { background: rgba(154, 123, 53, 0.18); color: #5A4520; box-shadow: inset 0 0 0 1px rgba(154, 123, 53, 0.42); }
      .meeting-mode-name { font-size: 14px; font-weight: 600; }
      .meeting-mode-hint { color: #7A7068; font-size: 12px; font-style: italic; }
      .meeting-error { padding: 8px 10px; border: 1px solid rgba(178, 78, 60, 0.5); border-radius: 2px; background: rgba(178, 78, 60, 0.12); color: #8B3A28; font-size: 13px; }
      .meeting-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 2px; padding-top: 13px; border-top: 1px solid rgba(46, 42, 38, 0.10); }
      .meeting-foot-hint { display: inline-flex; align-items: center; gap: 5px; color: #7A7068; font-size: 11px; }
      .meeting-foot-hint kbd { padding: 1px 5px; border: 1px solid rgba(46, 42, 38, 0.16); border-radius: 2px; background: rgba(46, 42, 38, 0.10); color: #4C453F; font-family: var(--font-mono, 'JetBrains Mono', monospace); font-size: 10px; }
      .meeting-buttons { display: flex; gap: 8px; }
      .meeting-btn { padding: 6px 18px; border: 1px solid transparent; border-radius: 3px; font-family: var(--font-main, 'EB Garamond', serif); font-size: 15px; letter-spacing: 0.01em; cursor: pointer; transition: background 120ms ease-out, border-color 120ms ease-out; }
      .meeting-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .meeting-cancel { border-color: rgba(46, 42, 38, 0.20); background: transparent; color: #7A7068; }
      .meeting-cancel:hover:not(:disabled) { background: rgba(46, 42, 38, 0.06); color: #2E2A26; }
      .meeting-submit { border-color: #2E6862; background: #3F8278; color: #FFFFFF; box-shadow: 0 1px 0 rgba(255, 252, 245, 0.22) inset; }
      .meeting-submit:hover:not(:disabled) { background: #4C9588; }
      @media (max-width: 640px) { .meeting-grid { grid-template-columns: 1fr; } }
    `
    document.head.appendChild(style)
  }
  injectProjectPickerStyles()
  injectParentPickerStyles()
}
