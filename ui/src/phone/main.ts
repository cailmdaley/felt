import './phone.css'
import {
  meetingDuration,
  meetingStateWord,
  paintTranscript,
  parseMeetingRecord,
  parseMeetingStatus,
  type MeetingStatus,
} from '../board/meeting.js'
import { daemonErrorMessage } from '../board/daemonApi.js'
import type { AgentEntry } from '../forms/agents'
import {
  CAPTURE_DEFAULT_AGENT,
  CAPTURE_DEFAULT_EFFORT,
  captureOutcome,
  captureRequestBody,
  type CaptureResponseData,
} from '../forms/captureApi'
import { stopMeeting } from '../forms/meetingApi'
import type { Host, Project } from '../forms/projectModel'
import { Mic, ScreenLock, audioContextForGesture } from './mic'
import { linkWords, phoneView, relayUrl } from './phoneState'
import { RelayLink } from './relay'
import { AudioSession } from './session'

/**
 * The phone page (`/phone`): a phone held up in an in-person meeting as hark's
 * microphone. It starts a `phone` meeting through the same capture request the
 * board's Capture form sends, or connects to one already live, and streams the
 * mic over `/api/v1/meeting/audio`, bound to that meeting's launch id. The
 * audio itself is owned by an `AudioSession`. One screen, polled every 2 s.
 */

const shuttleBase = (import.meta.env.VITE_SHUTTLE_BASE as string | undefined) ?? ''
const POLL_MS = 2_000
const PROJECT_KEY = 'shuttle.phone.project'

interface Page {
  status: MeetingStatus | null
  reachable: boolean
  starting: boolean
  stopping: boolean
  error: string | null
  notice: string | null
  hosts: Host[]
  projects: Project[]
  projectId: string | null
  agents: AgentEntry[] | null
}

const page: Page = {
  status: null,
  reachable: true,
  starting: false,
  stopping: false,
  error: null,
  notice: null,
  hosts: [],
  projects: [],
  projectId: null,
  agents: null,
}

const lock = new ScreenLock()

const session = new AudioSession({
  // The AudioContext is made here, synchronously inside the tap, and
  // getUserMedia is Mic.open's first await: both stay in the gesture on iOS.
  openMic: (handlers) => Mic.open(audioContextForGesture(), handlers),
  createRelay: (launch, events) => new RelayLink({ url: relayUrl(shuttleBase, window.location, launch), ...events }),
  lock,
  onChange: () => {
    if (session.link === 'ended' && !page.notice) {
      page.notice = session.linkReason ? `The meeting ended: ${session.linkReason}.` : 'The meeting ended.'
    }
    render()
  },
  onLevel: (peak) => {
    const percent = Math.round(Math.sqrt(peak) * 100)
    meterFill.style.width = `${percent}%`
    meter.setAttribute('aria-valuenow', String(percent))
    meter.classList.toggle('ph-meter-hot', peak > 0.9)
  },
})

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

// ---- The screen -----------------------------------------------------------

const root = document.getElementById('phone')!
const eyebrow = el('div', 'ph-eyebrow', 'shuttle · phone mic')
const meta = el('div', 'ph-meta')
const dot = el('span', 'ph-dot')
const stateWord = el('span', 'ph-state')
const clock = el('time', 'ph-clock')
meta.append(dot, stateWord, clock)
const headline = el('h1', 'ph-headline')
const detail = el('p', 'ph-detail')

const startForm = el('form', 'ph-start')
const note = el('textarea', 'ph-note')
note.rows = 3
note.placeholder = 'What’s the meeting? Who’s in it? (first line names it)'
const projectLabel = el('label', 'ph-field')
const projectSelect = el('select', 'ph-select')
projectLabel.append(el('span', 'ph-field-label', 'Scribe works in'), projectSelect)
const startButton = el('button', 'ph-primary', 'Start meeting')
startButton.type = 'submit'
startForm.append(note, projectLabel, startButton)

const connectButton = el('button', 'ph-primary', 'Connect mic')
connectButton.type = 'button'

const live = el('section', 'ph-live')
const meter = el('div', 'ph-meter')
const meterFill = el('div', 'ph-meter-fill')
meter.append(meterFill)
meter.setAttribute('role', 'meter')
meter.setAttribute('aria-label', 'Mic level')
meter.setAttribute('aria-valuemin', '0')
meter.setAttribute('aria-valuemax', '100')
const linkLine = el('p', 'ph-link')
const keepOn = el('p', 'ph-keep-on')
live.append(meter, linkLine, keepOn)

const warning = el('div', 'ph-warning')
warning.setAttribute('role', 'alert')
const warningText = el('span')
const restoreButton = el('button', 'ph-secondary', 'Restore mic')
restoreButton.type = 'button'
const dismissWarning = el('button', 'ph-link-button', 'Dismiss')
dismissWarning.type = 'button'
warning.append(warningText, restoreButton, dismissWarning)

const error = el('div', 'ph-error')
error.setAttribute('role', 'alert')
const notice = el('div', 'ph-notice')
notice.setAttribute('role', 'status')

const tail = el('ol', 'ph-tail')
tail.setAttribute('aria-label', 'Live transcript')

const stopButton = el('button', 'ph-stop', 'Stop meeting')
stopButton.type = 'button'

root.append(eyebrow, meta, headline, detail, warning, error, notice, startForm, connectButton, live, tail, stopButton)

function streaming(): boolean {
  return session.mic !== null
}

function render(): void {
  const view = phoneView({
    status: page.status,
    reachable: page.reachable,
    streaming: streaming(),
    starting: page.starting,
  })
  const meeting = page.status?.meeting ?? null
  const active = meeting && meeting.state !== 'failed'

  root.dataset.meeting = active ? meeting.state : 'none'
  meta.hidden = !active
  stateWord.textContent = active ? meetingStateWord(meeting.state) : ''
  const duration = active ? meetingDuration(meeting) : null
  clock.textContent = duration ?? ''
  headline.textContent = view.headline
  detail.textContent = view.detail ?? ''
  detail.hidden = !view.detail

  startForm.hidden = view.primary !== 'start'
  startButton.disabled = page.starting || session.busy || !page.projectId
  connectButton.hidden = view.primary !== 'connect'
  connectButton.disabled = session.busy
  stopButton.hidden = !view.canStop
  stopButton.disabled = page.stopping
  stopButton.textContent = page.stopping ? 'Stopping…' : active ? 'Stop meeting' : 'Turn the mic off'

  live.hidden = !streaming()
  live.dataset.link = session.lostSince !== null ? 'lost' : session.link
  linkLine.textContent = linkWords(session.link, session.linkReason, session.lostSince)
  keepOn.textContent = lock.held
    ? 'Keep this screen on and Safari in front: iOS may cut the mic when the screen locks or you switch apps. (Screen kept awake.)'
    : 'Keep this screen on and Safari in front: iOS may cut the mic when the screen locks or you switch apps.'

  const terminal = session.link === 'refused' || session.link === 'replaced'
  const errorText = page.error ?? session.error ?? (terminal ? linkWords(session.link, session.linkReason) : null)
  warning.hidden = !session.warning && !session.needsRestore
  warningText.textContent = session.warning ?? 'The mic needs restoring.'
  restoreButton.hidden = !session.needsRestore
  error.hidden = !errorText
  error.textContent = errorText ?? ''
  notice.hidden = !page.notice
  notice.textContent = page.notice ?? ''

  paintTranscript(tail, active ? meeting.tail : [])
}

function renderProjects(): void {
  projectSelect.replaceChildren()
  for (const host of page.hosts) {
    const projects = page.projects.filter((project) => project.originId === host.id)
    if (projects.length === 0) continue
    const group = el('optgroup')
    group.label = host.label
    for (const project of projects) {
      const option = el('option', undefined, project.name)
      option.value = project.id
      group.append(option)
    }
    projectSelect.append(group)
  }
  if (page.projectId) projectSelect.value = page.projectId
}

// ---- Daemon reads ---------------------------------------------------------

async function poll(): Promise<void> {
  try {
    const response = await fetch(`${shuttleBase}/api/v1/meeting`, { cache: 'no-store' })
    const body: unknown = await response.json().catch(() => null)
    const status = response.ok ? parseMeetingStatus(body) : null
    page.reachable = status !== null
    if (status) page.status = status
  } catch {
    page.reachable = false
  }
  render()
}

function remembered(): string | null {
  try {
    return localStorage.getItem(PROJECT_KEY)
  } catch {
    return null
  }
}

function remember(projectId: string): void {
  try {
    localStorage.setItem(PROJECT_KEY, projectId)
  } catch {
    // A private window keeps nothing; the default project is chosen again.
  }
}

/** The capture's effort for its default agent, as the Capture form resolves it. */
let resolveEffort: (agent: AgentEntry | undefined, effort: string) => string = () => ''

/**
 * The projects the scribe can land in, and the agent registry. The feed reader
 * shares the board's modules (markdown, KaTeX), so it loads after the page is
 * up rather than holding up the first paint.
 */
async function loadChoices(): Promise<void> {
  try {
    const [{ loadFeed }, agents] = await Promise.all([
      import('../forms/projectFeed'),
      import('../forms/agents'),
    ])
    resolveEffort = agents.resolveEffort
    const { model } = await loadFeed(shuttleBase)
    page.hosts = model.hosts
    page.projects = model.projects
    // The Capture form's default: the local host's most recent project.
    const localHost = model.hosts.find((host) => host.isLocal)?.id ?? model.hosts[0]?.id
    const fallback = model.projects.find((project) => project.originId === localHost) ?? model.projects[0]
    const saved = remembered()
    page.projectId = model.projects.some((project) => project.id === saved) ? saved : fallback?.id ?? null
    if (!page.projectId) page.error = 'No project to start a scribe in: register one from the board first.'
  } catch (err) {
    page.error = `Couldn’t load projects: ${daemonErrorMessage(err)}`
  }
  renderProjects()
  render()
  try {
    const response = await fetch(`${shuttleBase}/api/v1/agents`)
    const agents: unknown = response.ok ? await response.json() : null
    if (Array.isArray(agents)) page.agents = agents as AgentEntry[]
  } catch {
    // Without the registry the capture goes without an effort, as the form's does.
  }
}

// ---- Actions --------------------------------------------------------------

function clearMessages(): void {
  page.error = null
  page.notice = null
}

async function start(): Promise<void> {
  if (page.starting || session.busy) return
  const project = page.projects.find((candidate) => candidate.id === page.projectId)
  if (!project) {
    page.error = 'Pick a project for the scribe to work in.'
    render()
    return
  }
  clearMessages()
  // Inside the tap: the mic first, then the meeting.
  const opening = session.begin()
  page.starting = true
  render()
  const generation = await opening
  if (generation === null) {
    page.starting = false
    render()
    return
  }
  try {
    const agent = page.agents?.find((entry) => entry.id === CAPTURE_DEFAULT_AGENT)
    const effort = resolveEffort(agent, CAPTURE_DEFAULT_EFFORT)
    const response = await fetch(`${shuttleBase}/api/v1/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(captureRequestBody({
        prompt: note.value,
        projectDir: project.path,
        origin: project.originId,
        agent: CAPTURE_DEFAULT_AGENT,
        ...(effort ? { effort } : {}),
        meetingMode: 'phone',
      })),
    })
    const data = (await response.json().catch(() => ({}))) as CaptureResponseData
    const host = page.hosts.find((candidate) => candidate.id === project.originId)?.label ?? project.originId
    const outcome = captureOutcome(response, data, { projectDir: project.path, meetingMode: 'phone', host })
    if (outcome.kind === 'error') throw new Error(outcome.message)
    if (outcome.kind === 'meeting-recording' && outcome.error) page.error = outcome.error
    else page.notice = `Recording; the scribe is starting on ${host}.`
    note.value = ''
    // `stream` ignores a generation that Stop has already moved past.
    session.stream(generation, parseMeetingRecord(data.meeting)?.launch ?? null)
  } catch (err) {
    session.stop()
    page.error = daemonErrorMessage(err)
  } finally {
    page.starting = false
    await poll()
  }
}

async function connect(): Promise<void> {
  if (session.busy) return
  const launch = page.status?.meeting?.launch ?? null
  clearMessages()
  const generation = await session.begin()
  if (generation !== null) session.stream(generation, launch)
  render()
}

async function stop(): Promise<void> {
  if (page.stopping) return
  const meeting = page.status?.meeting
  if (!meeting || meeting.state === 'failed') {
    session.stop()
    return
  }
  page.stopping = true
  page.error = null
  render()
  try {
    await stopMeeting(shuttleBase)
    session.stop()
    page.notice = 'Meeting stopped.'
  } catch (err) {
    // The meeting still records, and this phone is still its mic.
    page.error = `Couldn’t stop the meeting: ${daemonErrorMessage(err)}`
  } finally {
    page.stopping = false
    await poll()
  }
}

startForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void start()
})
connectButton.addEventListener('click', () => { void connect() })
stopButton.addEventListener('click', () => { void stop() })
projectSelect.addEventListener('change', () => {
  page.projectId = projectSelect.value
  remember(projectSelect.value)
  render()
})
restoreButton.addEventListener('click', () => { void session.restore() })
dismissWarning.addEventListener('click', () => {
  session.warning = null
  render()
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  session.returned()
  void poll()
})

// The mic can fail while the page stays in front (a call, the system taking
// the audio): look once a second so Restore shows at once.
setInterval(() => session.check(), 1_000)

window.addEventListener('pagehide', () => session.stop())

render()
void loadChoices()
void poll()
setInterval(() => { if (document.visibilityState === 'visible') void poll() }, POLL_MS)
