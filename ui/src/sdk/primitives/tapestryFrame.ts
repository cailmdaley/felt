import type { ShuttleClient } from '../client.js'
import { fileKindOf, tapestryPathOf } from '../model.js'
import { declaredPageOf, remotePageFrame } from '../remotePage.js'
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
 * `data-empty` flag. A page joins the root once its head is read; one that declares
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
  const served = (): HTMLIFrameElement => {
    const frame = part('iframe', 'frame')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.src = page ? client.htmlAssetUrl(path, fiber.origin) : client.fileUrl(path, fiber.origin)
    frame.title = title
    return frame
  }
  if (!page) root.append(served())
  else void declaredPageOf(client, path, fiber.origin).then(remote => {
    // A declared page that lands on the board's own origin gives way to the served file.
    const frame = remote ? remotePageFrame(remote, title, () => frame.replaceWith(served())) : served()
    frame.dataset.slot = 'frame'
    root.append(frame)
  })
  return root
}
