import type { ShuttleClient } from '../client.js'
import { tapestryPathOf } from '../model.js'
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
 * companion page on its owner in a `<iframe data-slot="frame"
 * sandbox="allow-scripts">`, or, when the owner found none, an `empty` slot
 * and the root's `data-empty` flag.
 */
export function createTapestryFrame(fiber: ShuttleFiber, client: ShuttleClient, options: TapestryFrameOptions = {}): HTMLDivElement {
  const root = part('div', 'shuttle-tapestry-frame')
  const path = tapestryPathOf(fiber)
  flag(root, 'empty', !path)
  if (path) {
    const frame = part('iframe', 'frame')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.src = client.fileUrl(path, fiber.origin)
    frame.title = options.title ?? `${fiber.fiber.name} — tapestry`
    root.append(frame)
  } else {
    root.append(part('p', 'empty', options.emptyText ?? 'No tapestry yet.'))
  }
  return root
}
