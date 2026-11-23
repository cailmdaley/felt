/**
 * The Shuttle UI primitives: a client for the daemon's core API, a live feed,
 * headless readings of its rows, and unstyled, accessible elements built on
 * `@ui-sdk/core` and `@ui-sdk/web`. Every element names its parts with
 * `data-slot` and its state with `data-*` attributes, and carries no class,
 * style, colour or font: a page arranges and skins them as it likes.
 *
 * The daemon serves this module bundled at `/sdk/shuttle-sdk.js`:
 *
 *     import { ShuttleClient, ShuttleFeed, createThreadRow } from '/sdk/shuttle-sdk.js'
 */
export * from './types.js'
export {
  DaemonBootingError, DaemonRequestError, ShuttleClient, daemonErrorMessage, daemonFetch, isDaemonBooting, responseError,
  type CompositeRead, type ShuttleClientOptions,
} from './client.js'
export { ShuttleFeed, type ShuttleFeedOptions, type ShuttleFeedState, type ShuttleFeedStatus } from './feed.js'
export {
  ATTENTION_ORDER, GROUP_MS, TURN_WORD, askOf, attentionOf, buildFamilyTree, doingOf, fileKindOf, groupPosts, hasLiveWorker,
  isWaiting, isWorking, kindWord, lastActive, offersFor, relativeAge, roleOf, slugOf, tapestryPathOf, type ShuttleFileKind,
} from './model.js'
export { createTime, retimeAll, type TimeOptions } from './primitives/time.js'
export { createThreadRow, type ThreadRowDensity, type ThreadRowOptions } from './primitives/threadRow.js'
export { createPost, type PostOptions } from './primitives/post.js'
export { createFilePreview, sentFile, type FilePreviewFile, type FilePreviewOptions } from './primitives/filePreview.js'
export { createActionMenu, type ActionMenu, type ActionMenuOptions } from './primitives/actionMenu.js'
export { createLifecycleBar, type LifecycleBarOptions } from './primitives/lifecycleBar.js'
export { createComposer, type ComposerMode, type ComposerOptions } from './primitives/composer.js'
export { createTapestryFrame, type TapestryFrameOptions } from './primitives/tapestryFrame.js'
