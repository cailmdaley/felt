/**
 * WeekView (hotkey 4) — the week's shape at a glance.
 *
 * PLACEHOLDER. The page, the head and the registration are real; the body is
 * an empty state. Replacing this file with the real week view needs no change
 * anywhere else — the registration below is the whole wiring.
 */

import { registerView, type TemporalView, type ViewContext } from './ViewRegistry.js'
import { createViewEmptyState, createViewPage } from './ViewPage.js'

class WeekView implements TemporalView {
  readonly id = 'week' as const
  readonly title = 'Week'
  readonly hotkey = '4'

  private root: HTMLElement | null = null

  mount(host: HTMLElement, _ctx: ViewContext): void {
    const page = createViewPage(this.title)
    page.body.append(createViewEmptyState())
    this.root = page.root
    host.append(page.root)
  }

  refresh(_ctx: ViewContext): void {
    // Nothing to patch yet — the placeholder body does not read board data.
  }

  unmount(): void {
    this.root?.remove()
    this.root = null
  }
}

registerView(new WeekView())
