import './app.css'
import { KanbanModal } from './board/KanbanModal.js'
import { showToast } from './board/utils.js'
import { daemonFetch, isDaemonBooting } from './board/daemonApi.js'
import { loadMath } from './board/mathDollars.js'

/**
 * Entry point — mounts the kanban board against the Shuttle daemon.
 *
 * The board is a vanilla-TS/DOM widget (no React); Stash/Capture and the
 * viewer arrive as React islands in later slices. `shuttleBase` defaults to
 * empty (relative) so fetches are same-origin: the served bundle hits its own
 * daemon at :4000 with no CORS, and `npm run dev` reaches :4000 through the
 * Vite proxy. Override with `VITE_SHUTTLE_BASE` to target an absolute daemon.
 */
const shuttleBase =
  (import.meta.env.VITE_SHUTTLE_BASE as string | undefined) ?? ''

// The React forms load on first use, and in the background once the Desk is up.
type Forms = typeof import('./forms/mountForms.js')
const withForms = (open: (forms: Forms) => unknown): void => {
  import('./forms/mountForms.js').then(open, () => showToast('Couldn’t load the form; reload the board', 'error'))
}

// index.html preloads the webfonts' stylesheet so nothing waits on it; apply it.
const webfonts = document.getElementById('webfonts')
if (webfonts instanceof HTMLLinkElement) webfonts.rel = 'stylesheet'

const host = document.getElementById('app')
if (!host) throw new Error('#app host element is missing')

const board = new KanbanModal({
  shuttleBase,
  // Stash (`+`) / Capture (`✶`) header buttons — providing these callbacks is
  // what surfaces the buttons. Each opens its React island; the
  // result lands as a board toast. The board polls, so a new card appears on
  // its own once the daemon writes the fiber / the capture session claims it.
  onStashClick: () => {
    withForms(({ openStash }) => openStash({ shuttleBase, onResult: (msg, ok) => showToast(msg, ok ? 'success' : 'error') }))
  },
  onNewIdeaClick: () => {
    withForms(({ openCapture }) => openCapture({
      shuttleBase,
      onResult: (msg, ok) => showToast(msg, ok ? 'success' : 'error'),
      onMeetingResult: (msg, tone) => showToast(msg, tone),
      phoneAudio: board.phoneAudio,
      onMeetingStarted: (meeting) => board.meetingStarted(meeting),
    }))
  },
  // ⚙︎ at the right end of the tab strip, and ⌘, / , — the operator files of
  // any host in the fleet. Only a failure to even reach the daemon surfaces a
  // toast; everything else the sheet reports in place, beside the control that
  // caused it.
  onSettingsClick: () => {
    withForms(({ openSettings }) => openSettings({ shuttleBase, onResult: (msg, ok) => showToast(msg, ok ? 'success' : 'error') }))
  },
  // Aloft / ☞ needs-you-now → open the worker's tmux session in kitty. The
  // web app can't open a terminal itself (Portolan does it natively); the
  // daemon does, via POST /api/v1/attach (not owner-routed — the tab opens on
  // the host serving this UI, ssh-ing out for a remote worker). Success raises
  // kitty; only failures surface a toast.
  onOpenWorker: (tmuxSession, shuttleHost) => {
    void daemonFetch(`${shuttleBase}/api/v1/attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tmux_session: tmuxSession, shuttle_host: shuttleHost ?? null }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const detail = await res.text().catch(() => '')
          showToast(detail ? `Couldn’t open terminal: ${detail}` : 'Couldn’t open terminal', 'error')
        }
      })
      .catch((error: unknown) => {
        if (!isDaemonBooting(error)) showToast('Couldn’t reach the daemon to open the terminal', 'error')
      })
  },
})

board.mount(host)
// Once the board is idle, fetch what it holds back from first paint: the forms
// and KaTeX. Either one also loads on first use.
const prefetch = () => {
  void import('./forms/mountForms.js').catch(() => { /* Retried on first use. */ })
  void loadMath().catch(() => { /* Retried on the next formula. */ })
}
if ('requestIdleCallback' in window) requestIdleCallback(prefetch, { timeout: 5000 })
else setTimeout(prefetch, 2000)
