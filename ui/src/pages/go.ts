import { postDaemonJson } from '../board/daemonApi.js'

/**
 * Where `go` took Rex. `place` says whether the fiber has a live worker:
 * `went` false with place `live` is a worker Rex could not show (no Mac app
 * attached to its server), with place `none` a fiber with no live worker.
 */
export interface GoAnswer { went: boolean; place: string }

/**
 * The one verb a page has for moving Rex: `POST /api/v1/go`, which the daemon
 * routes to the fiber's owner. It shows the fiber's live worker in the Mac's
 * Rex app and starts nothing.
 */
export function go(base: string, fiber: { uid: string; host: string }): Promise<GoAnswer> {
  return postDaemonJson<GoAnswer>(base, '/api/v1/go', { fiber_id: fiber.uid, origin: fiber.host }, 'Go failed')
}
