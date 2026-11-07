import { inFlightModel } from '../family/inFlight.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { responseThreadIndex } from '../threads.js'
import { FamilyPage, type MapPlace } from '../workspace/FamilyPage.js'
import { registerView, type TemporalView, type ViewContext } from './ViewRegistry.js'

const KEY = 'shuttle.desk.map'
/** The Desk shows its map in this browser. */
export function deskIsMap(): boolean {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}
export function chooseDeskMap(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch { /* Storage is optional. */ }
}

const everyCard = (context: ViewContext): KanbanCard[] => [...context.cards, ...(context.response.threads ?? [])]

/** The Desk's other posture: everything in flight as one map, the same page a family has. */
class MapView implements TemporalView {
  readonly id = 'map' as const
  readonly title = 'Map'
  readonly hotkey = ''
  private page: FamilyPage | null = null
  private context: ViewContext | null = null
  private readonly place: MapPlace = { focus: null, view: null }

  mount(host: HTMLElement, context: ViewContext): void {
    const workspace = context.workspace!, feedsHost = workspace.globeHost
    this.page = new FamilyPage((card, doc) => { if (doc) feedsHost.openDocument(card, doc); else workspace.openFromDesk(card) }, (card, quiet) => { workspace.dock.openConversation(card, quiet) }, feedsHost.feeds, this.place, () => {}, () => {
      const settled = this.page?.settled
      feedsHost.see?.(settled?.path ? settled : null)
    })
    const desk = document.createElement('button')
    desk.type = 'button'
    desk.className = 'ws-family-drawing'
    desk.textContent = 'Desk'
    desk.title = 'Back to the Desk\'s cards (m)'
    desk.addEventListener('click', () => this.context?.showDesk?.())
    this.page.control(desk)
    feedsHost.onFeeds = () => { if (this.context) this.refresh(this.context) }
    host.append(this.page.el)
    this.refresh(context)
  }
  refresh(context: ViewContext): void {
    this.context = context
    if (context.workspace!.isActive) return
    const cards = everyCard(context), index = responseThreadIndex(context.response, () => cards), { feeds } = context.workspace!.globeHost
    this.page?.map({ key: 'in-flight', cards, model: now => inFlightModel(context.response.now, cards, index, feeds, now) })
  }
  unmount(): void {
    if (this.context) this.context.workspace!.globeHost.onFeeds = undefined
    this.page?.dispose()
    this.page = null
    this.context = null
  }
  keydown(event: KeyboardEvent): boolean { return !!this.page?.keydown(event) }
  reveal(id: string, origin: string): boolean {
    const card = this.context && everyCard(this.context).find(candidate => (candidate.uid === id || candidate.id === id) && candidate.originId === origin)
    return !!card && !!this.page?.flyTo(card)
  }
}
registerView(new MapView())

