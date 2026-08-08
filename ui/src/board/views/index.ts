/**
 * The temporal-view barrel. Importing this module is what puts the three
 * views in the registry — each view file calls `registerView` at module
 * scope, so IMPORT ORDER HERE IS TAB ORDER (chronicle · day · week).
 *
 * KanbanModal imports this one module; nothing else needs to know the view
 * files exist. Shared page styles load here too, alongside the imports, the
 * same way KanbanModal.ts pulls in KanbanModal.css.
 */

import './views.css'

import './ChronicleView.js'
import './DayView.js'
import './WeekView.js'

export {
  clearViews,
  collectCards,
  getView,
  listViews,
  normalizeFocusDate,
  registerView,
  type BoardViewId,
  type TemporalView,
  type ViewContext,
  type ViewId,
} from './ViewRegistry.js'
export {
  createTemporalFetchers,
  TEMPORAL_TTL_MS,
  type ActivityBucket,
  type ActivityResult,
  type NarrationCommit,
  type NarrationResult,
  type TemporalFetchers,
} from './TemporalData.js'
export { createViewEmptyState, createViewPage, type ViewPage } from './ViewPage.js'
