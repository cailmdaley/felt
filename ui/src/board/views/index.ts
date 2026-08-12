/**
 * The temporal-view barrel. Importing this module is what puts the three
 * views in the registry — each view file calls `registerView` at module
 * scope, so IMPORT ORDER HERE IS TAB ORDER (day · week · chronicle), which
 * follows the strip after Desk and matches the `1`-`4` hotkeys.
 *
 * KanbanModal imports this one module; nothing else needs to know the view
 * files exist. Shared page styles load here too, alongside the imports, the
 * same way KanbanModal.ts pulls in KanbanModal.css.
 */

import './views.css'

import './DayView.js'
import './WeekView.js'
import './ChronicleView.js'

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
export {
  createTemporalFetchers,
  type ActivityBucket,
  type ActivityResult,
  type CommitRecord,
  type SessionRecord,
  type TemporalFetchers,
  type TemporalOrigin,
  type TemporalOrigins,
} from './TemporalData.js'
export { createViewFallbackPage } from './ViewPage.js'
