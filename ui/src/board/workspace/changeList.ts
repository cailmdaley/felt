import { el } from './changeElements.js'

/** One PR a constitution follows, as `GET /changes/<id>` lists it: GitHub's metadata, or gh's error. */
export interface ChangePRListing {
  number: number
  title?: string
  head_branch?: string
  base_branch?: string
  state?: string
  draft?: boolean
  checks?: { total: number; passed: number; failed: number; pending: number }
  additions?: number
  deletions?: number
  error?: string
}

export interface ChangeListOptions {
  /** The PRs in the order the constitution names them. */
  prs: number[]
  /** GitHub's word on each, once read. */
  listings: Promise<ChangePRListing[]>
  /** The PR open when the page is drawn, if any. */
  opened?: number
  /** Bakes a PR into the slot under its bar. */
  open(slot: HTMLElement, pr: number): void
  /** The page moved: to a PR, or back to the list (undefined). */
  moved(pr: number | undefined): void
}

/**
 * A Change page for a constitution that follows several PRs: a list of them,
 * read from GitHub without a bake, whose rows each open their PR in the page
 * under a bar that leads back to the list and steps to its neighbours.
 */
export function drawChangeList(root: HTMLElement, options: ChangeListOptions): void {
  const known = new Map<number, ChangePRListing>()
  const listing = (n: number): ChangePRListing => known.get(n) ?? { number: n }
  let shown: number | undefined
  /** The PR last open, whose row takes the focus on the way back to the list. */
  let previous: number | undefined
  let list: HTMLElement | null = null
  let label: HTMLElement | null = null

  /** Draws the list, focusing the row of PR `focus` when one is named. */
  const showList = (focus?: number): void => {
    shown = undefined
    options.moved(undefined)
    const page = el('div', 'change-pr-list')
    page.append(el('p', 'change-section-note', `${options.prs.length} pull requests`))
    const rows = el('div', 'change-pr-rows')
    for (const n of options.prs) rows.append(row(listing(n), () => showPR(n)))
    page.append(rows)
    list = page
    root.replaceChildren(page)
    if (focus !== undefined) rows.querySelector<HTMLElement>(`[data-pr="${focus}"]`)?.focus({ preventScroll: true })
  }
  /** Opens PR `n`; a step keeps the focus on the step taken, or on the way back once there is no step further. */
  const showPR = (n: number, stepped?: -1 | 1): void => {
    previous = shown = n
    list = null
    options.moved(n)
    const at = options.prs.indexOf(n)
    const bar = el('div', 'change-pr-bar')
    const back = el('button', 'change-pr-back', '← PRs')
    back.type = 'button'
    back.title = 'Back to the list of PRs'
    back.addEventListener('click', () => showList(previous))
    label = el('span', 'change-pr-label')
    paintLabel()
    const step = (by: -1 | 1, glyph: string, name: string): HTMLButtonElement => {
      const to = options.prs[at + by]
      const node = el('button', 'change-pr-step', glyph)
      node.type = 'button'
      node.disabled = to === undefined
      node.title = to === undefined ? name : `${name}: #${to}`
      node.setAttribute('aria-label', node.title)
      node.addEventListener('click', () => { if (to !== undefined) showPR(to, by) })
      return node
    }
    const before = step(-1, '‹', 'Previous PR'), after = step(1, '›', 'Next PR')
    bar.append(back, label, before, after)
    const slot = el('div', 'change-pr-slot')
    const page = el('div', 'change-pr-open')
    page.append(bar, slot)
    root.replaceChildren(page)
    if (stepped) {
      const taken = stepped < 0 ? before : after
      ;(taken.disabled ? back : taken).focus({ preventScroll: true })
    }
    options.open(slot, n)
  }
  const paintLabel = (): void => {
    if (!label || shown === undefined) return
    const pr = listing(shown)
    label.textContent = pr.title ? `#${pr.number} ${pr.title}` : `#${pr.number}`
    label.title = label.textContent
  }

  if (options.opened !== undefined && options.prs.includes(options.opened)) showPR(options.opened)
  else showList()
  /** The row holding the focus, which keeps it when the list is redrawn. */
  const focused = (): number | undefined => {
    const row = list?.contains(document.activeElement) ? (document.activeElement as HTMLElement).closest<HTMLElement>('[data-pr]') : null
    return row ? Number(row.dataset.pr) : undefined
  }
  void options.listings.then(listings => {
    for (const pr of listings) known.set(pr.number, pr)
    if (list) showList(focused())
    else paintLabel()
  }, (error: unknown) => {
    for (const n of options.prs) known.set(n, { number: n, error: error instanceof Error ? error.message : String(error) })
    if (list) showList(focused())
  })
}

const STATE: Record<string, string> = { OPEN: 'Open', MERGED: 'Merged', CLOSED: 'Closed' }

/** A PR's row: number and title, then where it goes, its state, checks and size. */
function row(pr: ChangePRListing, open: () => void): HTMLButtonElement {
  const node = el('button', 'change-pr-row')
  node.type = 'button'
  node.dataset.pr = String(pr.number)
  node.addEventListener('click', open)
  const head = el('span', 'change-pr-head')
  head.append(el('span', 'change-pr-number', `#${pr.number}`), el('span', 'change-pr-title', pr.title ?? ''))
  node.append(head)
  const meta = el('span', 'change-pr-meta')
  if (pr.error) {
    meta.append(el('span', 'change-pr-error', pr.error))
  } else if (pr.state) {
    const state = pr.draft && pr.state === 'OPEN' ? 'Draft' : STATE[pr.state] ?? pr.state.toLowerCase()
    const status = el('span', 'change-pr-state', state)
    status.dataset.state = state.toLowerCase()
    meta.append(el('span', 'change-pr-branches', `${pr.head_branch} → ${pr.base_branch}`), status)
    const checks = checksLabel(pr.checks)
    if (checks) {
      const node = el('span', 'change-pr-checks', checks.text)
      node.dataset.checks = checks.tone
      meta.append(node)
    }
    const size = el('span', 'change-pr-size')
    size.append(el('span', 'change-pr-additions', `+${pr.additions ?? 0}`), ' ', el('span', 'change-pr-deletions', `−${pr.deletions ?? 0}`))
    meta.append(size)
  } else {
    meta.append(el('span', 'change-pr-pending', 'Reading GitHub…'))
  }
  node.append(meta)
  return node
}

function checksLabel(checks: ChangePRListing['checks']): { text: string; tone: string } | undefined {
  if (!checks?.total) return undefined
  if (checks.failed) return { text: `${checks.failed} of ${checks.total} checks failing`, tone: 'failed' }
  if (checks.pending) return { text: `${checks.pending} of ${checks.total} checks pending`, tone: 'pending' }
  return { text: `${checks.total} checks pass`, tone: 'passed' }
}
