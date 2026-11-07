import type { KanbanCard } from './KanbanTypes.js'
import { threadKey, type FamilyNeed, type ThreadIndex } from './threads.js'
import { threadRow } from './ThreadPeek.js'
import { turnOf } from './turn.js'
import { renderThreadTree } from './workspace/ThreadTree.js'
import { workerPlateFacts } from './workspace/workerPlate.js'
import './deskFrontier.css'

/** The rest of the family as two numbers: threads working, and threads needing the human (a turn or a verdict). */
export function familyCounts(others: Readonly<Record<FamilyNeed, number>>): { working: number; needs: number } {
  return { working: others.working, needs: others.yours + others.review }
}

const FOLDS_KEY = 'shuttle.desk.threads'
/** Each family's folds as this browser left them: the whole tree, and its resting shelf. */
type Fold = { all?: boolean; resting?: boolean }
/** The browser's folds, read afresh; this page's own where the browser keeps none. */
let folds: Record<string, Fold> = {}
function foldOf(family: string): Fold {
  try { folds = JSON.parse(localStorage.getItem(FOLDS_KEY) ?? '{}') as Record<string, Fold> } catch { /* this page's folds stand */ }
  return folds[family] ?? {}
}
function setFold(family: string, change: Fold): void {
  const fold = { ...foldOf(family), ...change }
  folds[family] = fold
  try { localStorage.setItem(FOLDS_KEY, JSON.stringify(folds)) } catch { /* the fold lasts this page only */ }
}

const NEEDS_YOU: ReadonlySet<string> = new Set(['waiting', 'to-review'])

/**
 * A family's Desk row, shared by desktop and phone. The row is the node that
 * set the family's column: a thread leads with a quiet crumb to its root. The
 * family's threads hang beneath that row as a tree. Folded, it shows the
 * threads that need the human (a turn or a verdict, as the count says), with
 * their ancestors for context; the count's caret opens the whole tree, its resting threads on a
 * shelf of their own. Archived threads are never drawn here. Folds are remembered per browser. A root
 * whose family a thread leads keeps its count, which takes you to that row.
 */
export function installFrontierDetails(host: HTMLElement, end: HTMLElement, card: KanbanCard, index: ThreadIndex, open: (card: KanbanCard, family?: boolean) => void, now = Date.now()): void {
  const self = index.card(card), family = index.family(self)
  const ancestry = index.ancestry(card)
  if (ancestry.length) {
    const crumb = document.createElement('span'); crumb.className = 'kbn-card-crumb'
    crumb.title = ancestry.map(part => part.name).join(' › ')
    const first = ancestry[0]
    const head = document.createElement(first.card ? 'button' : 'span')
    head.className = 'kbn-card-crumb-root'
    head.textContent = first.name
    if (first.card) {
      (head as HTMLButtonElement).type = 'button'
      head.addEventListener('click', event => { event.stopPropagation(); open(first.card!, true) })
    }
    crumb.append(head, ancestry.length > 1 ? ' / … / ' : ' / ')
    const title = host.querySelector('.kbn-card-name, .kbn-cluster-item-title')
    if (title) title.prepend(crumb)
    else host.prepend(crumb)
  }
  const carries = family.lead === self
  if (!carries && family.root !== self) return
  if (family.root !== self) host.setAttribute('aria-label', `${family.root.name} / ${host.getAttribute('aria-label') ?? card.name}`)
  // Every unarchived thread of the family but this row; a thread's root has a row of its own.
  const kin = index.summary(family.root).unfinished - (self === family.root || index.state(self) === 'archived' ? 0 : 1)
  const familyKey = threadKey(family.root)
  const others = index.others(card)
  const { working, needs } = familyCounts(others)
  if (kin > 0 && (carries || working || needs)) {
    const count = document.createElement('button'); count.type = 'button'; count.className = 'kbn-thread-count'
    count.dataset.family = familyKey
    const label = document.createElement('span')
    label.className = needs ? 'kbn-count-needs' : working ? 'kbn-count-working' : 'kbn-count-quiet'
    label.textContent = needs ? `${needs} ${needs === 1 ? 'needs' : 'need'} you` : working ? `${working} working` : `${kin} ${kin === 1 ? 'thread' : 'threads'}`
    if (needs && index.subtree(family.root).some(thread => thread !== self && turnOf(thread).turn === 'question')) label.dataset.asks = ''
    count.append(label)
    count.title = [
      others.yours > 0 && `${others.yours} your turn`,
      others.review > 0 && `${others.review} awaiting review`,
      working > 0 && `${working} working elsewhere in this family`,
    ].filter(Boolean).join(', ') || label.textContent
    end.prepend(count)
    if (carries) installThreads(host, count, self, index, open, now)
    else count.addEventListener('click', event => { event.stopPropagation(); reachLead(familyKey, () => open(family.root, true)) })
  }
  const { elapsed } = workerPlateFacts(card, now)
  if (elapsed) {
    const age = document.createElement('span'); age.className = 'kbn-row-elapsed'; age.textContent = elapsed
    end.prepend(age)
  }
}

/** The family's threads under its row, the count their caret. */
function installThreads(host: HTMLElement, count: HTMLButtonElement, self: KanbanCard, index: ThreadIndex, open: (card: KanbanCard) => void, now: number): void {
  const family = index.family(self), familyKey = threadKey(family.root)
  const caret = document.createElement('span'); caret.className = 'kbn-thread-caret'; caret.setAttribute('aria-hidden', 'true')
  count.append(caret)
  const list = document.createElement('div'); list.className = 'kbn-desk-threads'
  list.setAttribute('role', 'group'); list.setAttribute('aria-label', `Threads of ${family.root.name}`)
  // The threads are their own nodes: nothing on them reaches the row's click, drag, selection or long press.
  for (const type of ['click', 'pointerdown', 'mousedown', 'touchstart'] as const) list.addEventListener(type, event => event.stopPropagation())
  list.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation() })
  list.addEventListener('dragstart', event => { event.preventDefault(); event.stopPropagation() })
  list.addEventListener('toggle', event => {
    const shelf = event.target as HTMLElement
    if (shelf instanceof HTMLDetailsElement && shelf.dataset.threadDetails) setFold(familyKey, { [shelf.dataset.threadDetails]: shelf.open })
  }, true)
  const asking = new Set(index.subtree(family.root).filter(thread => thread !== self && NEEDS_YOU.has(index.state(thread))).map(threadKey))
  const draw = (): void => {
    const fold = foldOf(familyKey), all = !!fold.all
    count.setAttribute('aria-expanded', String(all))
    count.setAttribute('aria-label', `${count.title}; ${all ? 'fold' : 'show all'} the family's threads`)
    list.replaceChildren(...renderThreadTree(index, family.root, self, (thread, focus) => {
      const row = threadRow(thread, index, open); row.dataset.threadFocus = focus
      const { elapsed } = workerPlateFacts(thread, now)
      if (elapsed) { const age = document.createElement('span'); age.className = 'kbn-row-elapsed'; age.textContent = elapsed; row.append(age) }
      return row
    }, {
      restingOpen: !!fold.resting,
      only: all ? undefined : thread => asking.has(threadKey(thread)),
      withRoot: false,
    }))
    list.hidden = !list.childElementCount
  }
  count.addEventListener('click', event => {
    event.stopPropagation()
    setFold(familyKey, { all: count.getAttribute('aria-expanded') !== 'true' })
    draw()
  })
  draw()
  host.append(list)
}

/** Opens the threads under the family's leading row and brings it into view; `elsewhere` when it is not drawn. */
function reachLead(familyKey: string, elsewhere: () => void): void {
  const lead = [...document.querySelectorAll<HTMLButtonElement>('.kbn-thread-count[aria-expanded]')].find(other => other.dataset.family === familyKey)
  if (!lead) { elsewhere(); return }
  if (lead.getAttribute('aria-expanded') !== 'true') lead.click()
  lead.focus({ preventScroll: true })
  lead.closest('[data-card-uid]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}
