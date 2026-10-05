/**
 * The view barrel. Importing this module is what puts the views in the
 * registry — each view file calls `registerView` at module scope, so IMPORT
 * ORDER HERE IS TAB ORDER (chronicle · board), which follows the strip after
 * Desk and matches the `1`-`3` hotkeys.
 *
 * KanbanModal imports this one module; nothing else needs to know the view
 * files exist. Shared page styles load here too, alongside the imports, the
 * same way KanbanModal.ts pulls in KanbanModal.css.
 */

import './views.css'

import './ChronicleView.js'
import './BoardView.js'

export {
  blockingDialogOpen,
  collectCards,
  getView,
  keystrokeIsSpokenFor,
  settingsHotkey,
  listViews,
  viewFallbackKind,
  type BoardViewId,
  type SettingsHotkey,
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
  type TemporalOrigins,
} from './TemporalData.js'
export { createViewFallbackPage } from './ViewPage.js'
