import type { ShuttleClient } from '../client.js'
import { fileKindOf, tapestryPathOf } from '../model.js'
import { remotePage, remotePageFrame } from '../remotePage.js'
import type { ShuttleFiber } from '../types.js'
import { flag, part } from './dom.js'

export interface TapestryFrameOptions {
  /** The frame's accessible title. */
  title?: string
  /** What the empty state says. */
  emptyText?: string
}

/**
 * A fiber's tapestry, `<div data-slot="shuttle-tapestry-frame">`: its
 * companion page on its owner in an `<iframe data-slot="frame"
 * sandbox="allow-scripts">`, addressed so its relative figures and styles
 * resolve, or, when the owner found none, an `empty` slot and the root's
 * `data-empty` flag. A page joins the root once it is read; one that declares
 * itself a public page elsewhere (`<meta name="shuttle-page">`) is framed as
 * that page, at its own origin.
 */
export function createTapestryFrame(fiber: ShuttleFiber, client: ShuttleClient, options: TapestryFrameOptions = {}): HTMLDivElement {
  const root = part('div', 'shuttle-tapestry-frame')
  const path = tapestryPathOf(fiber)
  flag(root, 'empty', !path)
  if (!path) {
    root.append(part('p', 'empty', options.emptyText ?? 'No tapestry yet.'))
    return root
  }
  const title = options.title ?? `${fiber.fiber.name} — tapestry`
  const page = fileKindOf(path) === 'page'
  const served = page ? client.htmlAssetUrl(path, fiber.origin) : client.fileUrl(path, fiber.origin)
  const mount = (remote: string | null): void => {
    const frame = remote ? remotePageFrame(remote, title) : part('iframe', 'frame')
    frame.dataset.slot = 'frame'
    if (!remote) {
      frame.setAttribute('sandbox', 'allow-scripts')
      frame.src = served
      frame.title = title
    }
    root.append(frame)
  }
  if (!page) mount(null)
  else void client.fileText(path, fiber.origin).catch(() => '').then(html => mount(remotePage(html, [location.href, served])))
  return root
}
