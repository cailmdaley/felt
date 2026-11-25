import type { ShuttleClient } from '../client.js'
import { fileKindOf, type ShuttleFileKind } from '../model.js'
import { declaredPageOf } from '../remotePage.js'
import type { ShuttleSentFile } from '../types.js'
import { button, part } from './dom.js'
import { createTime } from './time.js'

/** A file a preview shows: its path on its owner, and what a send said of it. */
export interface FilePreviewFile {
  path: string
  name?: string
  /** Epoch ms it was sent. */
  at?: number
  caption?: string
}

export interface FilePreviewOptions {
  /** The owner of the file (a composite row's `origin`). */
  origin?: string
  /** `row` lists the file in one line instead of previewing it; by default its kind decides. */
  kind?: ShuttleFileKind | 'row'
  now?: number
  /** Opens the file; given it, the name is a button. */
  onOpen?(file: FilePreviewFile): void
}

/** A sent file (`/sent-files`) as a preview's file. */
export const sentFile = (file: ShuttleSentFile): FilePreviewFile =>
  ({ path: file.fullPath, name: file.basename, ...(file.timestamp ? { at: file.timestamp } : {}), ...(file.caption ? { caption: file.caption } : {}) })

const extension = (name: string): string => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toUpperCase() ?? 'FILE'

/**
 * A file as `<div data-slot="shuttle-file-preview" data-kind>`: a `figure`
 * shows its picture in an `<img>`, a `page` the top of its page in an inert
 * `<iframe>` that runs no scripts, once its head is read, a `card` or a `row`
 * its extension; a page that declares a public page elsewhere
 * (`<meta name="shuttle-page">`) is a `card` naming that page's site. Each has
 * its `name`, its `caption` when a send gave one, and its `age`.
 */
export function createFilePreview(input: FilePreviewFile | ShuttleSentFile, client: ShuttleClient, options: FilePreviewOptions = {}): HTMLDivElement {
  const file = 'fullPath' in input ? sentFile(input) : input
  const name = file.name ?? file.path.split('/').pop() ?? file.path
  const kind = options.kind ?? fileKindOf(file.path)
  const root = part('div', 'shuttle-file-preview')
  root.dataset.kind = kind
  root.dataset.path = file.path
  let media: HTMLElement
  if (kind === 'figure') {
    const img = part('img', 'media')
    img.src = client.fileUrl(file.path, options.origin)
    img.alt = name
    img.loading = 'lazy'
    media = img
  } else if (kind === 'page') {
    const frame = part('iframe', 'media')
    frame.setAttribute('sandbox', '')
    frame.toggleAttribute('inert', true)
    frame.tabIndex = -1
    frame.title = name
    frame.loading = 'lazy'
    media = frame
    void declaredPageOf(client, file.path, options.origin).then(remote => {
      if (!remote) { frame.src = client.htmlAssetUrl(file.path, options.origin); return }
      const site = part('span', 'media', new URL(remote).host)
      root.dataset.kind = 'card'
      frame.replaceWith(site)
    })
  } else {
    media = part('span', 'media', extension(name))
    media.setAttribute('aria-hidden', 'true')
  }
  const title = options.onOpen ? button('name', name, () => options.onOpen?.(file)) : part('span', 'name', name)
  root.append(media, title)
  if (file.caption) root.append(part('span', 'caption', file.caption))
  if (file.at) {
    const age = part('span', 'age')
    age.append(createTime(file.at, options.now ?? Date.now()))
    root.append(age)
  }
  return root
}
