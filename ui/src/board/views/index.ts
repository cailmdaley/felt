/**
 * The view barrel. Importing this module puts the registered views into the
 * registry — each view file calls `registerView` at module scope, so IMPORT
 * ORDER HERE IS TAB ORDER (channels), following Desk and matching `1`–`2`.
 * A plugin registered later (`registerView`) takes the next tab and digit.
 *
 * KanbanModal imports this one module; nothing else needs to know the view
 * files exist. Shared page styles load here too, alongside the imports, the
 * same way KanbanModal.ts pulls in KanbanModal.css.
 */

import './views.css'

import './ChannelsView.js'

export {
  DESK_HOTKEY,
  DESK_VIEW,
  blockingDialogOpen,
  collectCards,
  getView,
  keystrokeIsSpokenFor,
  settingsHotkey,
  listViews,
  onViewsChange,
  registerView,
  unregisterView,
  viewFallbackKind,
  viewForHotkey,
  viewHotkeys,
  viewTitle,
  type BoardViewId,
  type BoardViewPlugin,
  type TemporalView,
  type ViewContext,
} from './ViewRegistry.js'
export { createViewFallbackPage } from './ViewPage.js'
