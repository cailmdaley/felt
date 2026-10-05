import { registerView, type TemporalView, type ViewContext } from './ViewRegistry.js'

/** The Board's contact sheet shares the workspace's session lifetime. */
class BoardView implements TemporalView {
  readonly id = 'shelf' as const
  readonly title = 'Board'
  readonly hotkey = '3'
  private context: ViewContext | null = null
  private host: HTMLElement | null = null

  mount(host: HTMLElement, context: ViewContext): void {
    this.host = host
    this.refresh(context)
  }
  refresh(context: ViewContext): void {
    this.context = context
    if (this.host) context.workspace?.mountOverview(this.host)
  }
  unmount(): void {
    this.context?.workspace?.hideOverview()
    this.context = null
    this.host = null
  }
}
registerView(new BoardView())
