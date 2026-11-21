/**
 * The view barrel. Importing this module puts the registered views into the
 * registry — each view file calls `registerView` at module scope, so IMPORT
 * ORDER HERE IS TAB ORDER (channels), following Desk and matching `1`–`2`.
 *
 * KanbanModal imports this one module; nothing else needs to know the view
 * files exist. Shared page styles load here too, alongside the imports, the
 * same way KanbanModal.ts pulls in KanbanModal.css.
 */

import './views.css'

import './ChannelsView.js'

export {
  blockingDialogOpen,
  collectCards,
  getView,
  keystrokeIsSpokenFor,
  settingsHotkey,
  listViews,
  viewFallbackKind,
  type BoardViewId,
  type TemporalView,
  type ViewContext,
} from './ViewRegistry.js'
export { createViewFallbackPage } from './ViewPage.js'
