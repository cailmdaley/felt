/**
 * The view barrel. Importing this module is what puts the four views in the
 * registry — each view file calls `registerView` at module scope, so IMPORT
 * ORDER HERE IS TAB ORDER (day · week · chronicle · shelf), which follows the
 * strip after Desk and matches the `1`-`5` hotkeys.
 *
 * KanbanModal imports this one module; nothing else needs to know the view
 * files exist. Shared page styles load here too, alongside the imports, the
 * same way KanbanModal.ts pulls in KanbanModal.css.
 */

import './views.css'

import './DayView.js'
import './WeekView.js'
import './ChronicleView.js'
import './ShelfView.js'

export {
  collectCards,
  getView,
  keystrokeIsSpokenFor,
  listViews,
  normalizeFocusDate,
  viewFallbackKind,
  type BoardViewId,
  type TemporalView,
  type ViewContext,
} from './ViewRegistry.js'
export { createTemporalFetchers, type TemporalFetchers } from './TemporalData.js'
export { createViewFallbackPage } from './ViewPage.js'
