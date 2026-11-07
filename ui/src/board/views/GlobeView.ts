import type { KanbanCard } from '../KanbanTypes.js'
import { GlobeStage, freshPlace } from '../globe/GlobeStage.js'
import { responseThreadIndex } from '../threads.js'
import { registerView, type TemporalView, type ViewContext } from './ViewRegistry.js'

const everyCard = (context: ViewContext): KanbanCard[] => [...context.cards, ...(context.response.threads ?? [])]

/** The whole fleet on one sphere, as nested HEALPix cells; the stage is kept while a page stands over it. */
class GlobeView implements TemporalView {
  readonly id = 'globe' as const
  readonly title = 'Globe'
  readonly hotkey = '5'
  private stage: GlobeStage | null = null
  private context: ViewContext | null = null
  private readonly place = freshPlace()

  mount(host: HTMLElement, context: ViewContext): void {
    const workspace = context.workspace!
    this.stage = new GlobeStage(workspace.globeHost, () => workspace.isActive, () => { if (this.context) this.refresh(this.context) }, this.place)
    host.append(this.stage.el)
    this.refresh(context)
  }
  refresh(context: ViewContext): void {
    this.context = context
    const cards = everyCard(context)
    this.stage?.update(responseThreadIndex(context.response, () => cards), cards)
  }
  unmount(): void {
    this.stage?.dispose()
    this.stage = null
    this.context = null
  }
  keydown(event: KeyboardEvent): boolean { return !!this.stage?.keydown(event) }
  reveal(id: string, origin: string): boolean { return !!this.stage?.follow(id, origin) }
}
registerView(new GlobeView())
