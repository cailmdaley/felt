import { disposeHighlighter, registerCustomCSSVariableTheme } from '@pierre/diffs'
import {
  assignLanes,
  type ChangeRange,
  type ChangeBundle,
  type ChangeFile,
  type ChangeHunk,
  type ChangeWindow,
} from './changeModel.js'
import './change-reader.css'
import { el, prose, button, stored, save, revisionLabel } from './changeElements.js'
import { createChangeReview } from './changeReview.js'
import { createChangeNavigation } from './changeNavigation.js'
import { mountChangeWindow } from './changeWindow.js'
import { changeMap } from './changeMap.js'
import { changeFileLabel } from './changeFileLabel.js'
import { readingAnchor, windowRows, type ChangeReadingState } from './changePosition.js'

registerCustomCSSVariableTheme('shuttle-change', {})
export { disposeHighlighter as releaseChangeHighlighter }
/** Native review content; the workspace owns its file, gestures, scroll position and worker route. */
export function mountChangeReader(
  root: HTMLElement,
  bundle: ChangeBundle,
  identity: string,
  revision: string,
  send?: (message: string) => Promise<void>,
  canSend = () => true,
  reviewTarget = () => 'this fiber',
) {
  const files = bundle.files
  const lanes = assignLanes(bundle)
  const prefix = `shuttle:change:${JSON.stringify([identity, bundle.base, bundle.head, revision])}`
  const reading = stored<ChangeReadingState>(`${prefix}:position`, { expanded: [], whole: [] })
  const wholeFiles = new Set(reading.whole)
  const shell = el('div', 'change-reader')
  const rail = el('nav', 'change-contents')
  rail.setAttribute('aria-label', 'Change contents')
  const scroll = el('div', 'change-scroll')
  scroll.tabIndex = -1
  const main = el('main', 'change-main')
  scroll.append(main)
  shell.append(rail, scroll)
  root.append(shell)
  const navigation = createChangeNavigation(shell, rail, scroll, main, prefix)
  const { section, mark, reveal, sections, updateProgress } = navigation
  const heading = el('header', 'change-heading')
  heading.append(
    el('p', 'change-eyebrow', `${bundle.repo.name} / CHANGE`),
    el('h1', '', bundle.title),
  )
  heading.append(
    el(
      'p',
      'change-revisions',
      `${revisionLabel(bundle.base_ref, bundle.base)} → ${revisionLabel(bundle.head_ref, bundle.head)}`,
    ),
  )
  const additions = files.reduce((count, file) => count + file.additions, 0)
  const deletions = files.reduce((count, file) => count + file.deletions, 0)
  const summary = `${files.length} files · +${additions} −${deletions} · ${bundle.commits.length} commits`
  heading.append(el('p', 'change-summary', summary))
  const map = bundle.areas && changeMap(bundle.areas, area => {
    const chapter = area.chapter && chapterHosts.get(area.chapter)
    if (chapter) reveal(chapter)
    else if (area.role === 'test') reveal(tests.element)
    else {
      const view = views.find(view => area.files.includes(view.file.path))
      if (view) reveal(view.card)
      else reveal(remaining.element)
    }
  })
  const chapterHosts = new Map<string, HTMLElement>()
  if (map) main.append(map)
  main.append(heading)
  if (bundle.story) main.append(prose(bundle.story.overview))
  else
    main.append(
      el(
        'p',
        'change-section-note',
        'No authored story. Read implementation first, then configuration and documentation; tests stay together.',
      ),
    )
  const review = createChangeReview(
    shell,
    scroll,
    bundle,
    identity,
    reveal,
    send,
    canSend,
    reviewTarget,
  )
  // The slot wrapper lives in light DOM, so workspace typography and form controls apply to comments.
  const mountWindow = (host: HTMLElement, window: ChangeWindow, file: ChangeFile) => {
    return review.track(mountChangeWindow(host, window, file, review.windowComments(file)))
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const host = entry.target as HTMLElement,
          window = windows.get(host)
        if (!window) continue
        if (entry.isIntersecting && !window.mounted)
          window.mounted = mountWindow(host, window.hunk, window.file)
        else if (!entry.isIntersecting && window.mounted) {
          host.style.minHeight = `${host.offsetHeight}px`
          window.mounted.dispose()
          window.mounted = undefined
        }
      }
    },
    { root: scroll, rootMargin: '800px 0px' },
  )
  const windows = new Map<
    HTMLElement,
    { file: ChangeFile; hunk: ChangeWindow; mounted?: ReturnType<typeof mountWindow> }
  >()
  const views: { card: HTMLElement; file: ChangeFile; showAll: () => void }[] = []
  const jumpToRange = (range: ChangeRange): void => {
    const candidates = views.filter((view) => view.file.path === range.file)
    const matchingWindow = (card: HTMLElement): HTMLElement | undefined =>
      [...card.querySelectorAll<HTMLElement>('.change-diff-window')].find((host) => {
        if (range.from === undefined) return true
        const hunk = windows.get(host)!.hunk,
          start = range.side === 'old' ? hunk.old_from : hunk.new_from
        const count = range.side === 'old' ? hunk.old_lines : hunk.new_lines
        return count > 0 && range.from >= start && range.from < start + count
      })
    const view = candidates.find((view) => matchingWindow(view.card)) ?? candidates[0]
    if (!view) return
    if (!matchingWindow(view.card)) view.showAll()
    const host = matchingWindow(view.card)
    if (!host) {
      reveal(view.card)
      return
    }
    const window = windows.get(host)!
    if (!window.mounted) window.mounted = mountWindow(host, window.hunk, window.file)
    reveal(host)
    const target = {
      element: () => {
        const excluded = range.side === 'old' ? 'change-addition' : 'change-deletion'
        return (
          host
            .querySelector('diffs-container')
            ?.shadowRoot?.querySelector(
              `[data-column-number="${range.from}"]:not([data-line-type="${excluded}"])`,
            ) ??
          host.querySelector(
            `.change-plain-row[data-${range.side === 'old' ? 'old' : 'new'}-line="${range.from}"]`,
          )
        )
      },
      offset: scroll.clientHeight / 2,
    }
    navigation.anchor(target.element, target.offset, window.mounted.ready)
  }
  const addDiff = (parent: HTMLElement, file: ChangeFile, hunks: ChangeHunk[]): void => {
    const slices = hunks.flatMap((hunk) => hunk.windows)
    if (!slices.length) {
      parent.append(el('pre', 'change-metadata', `${file.status} · no text hunks\n${file.header}`))
      return
    }
    for (const slice of slices) {
      const host = el('div', 'change-diff-window')
      host.dataset.windowId = JSON.stringify([
        parent.closest<HTMLElement>('.change-file')!.dataset.viewId,
        slice.start,
      ])
      host.style.minHeight = `${slice.rows * 20 + 68}px`
      parent.append(host)
      windows.set(host, { file, hunk: slice })
      io.observe(host)
    }
  }
  const addFile = (
    parent: HTMLElement,
    file: ChangeFile,
    hunks: ChangeHunk[],
    id: string,
    sectionIds: string[],
    stop?: { note?: string; importance?: string; from?: number; to?: number; side?: string },
  ): void => {
    const collapsed = file.role === 'generated' && !stop
    const card = el(collapsed ? 'details' : 'article', 'change-file')
    card.dataset.changeFile = file.path
    card.dataset.viewId = id
    card.dataset.status = file.status
    const head = el(collapsed ? 'summary' : 'header', 'change-file-head')
    const end = stop?.to && stop.to !== stop.from ? `–${stop.to}` : ''
    const side = stop?.side === 'old' ? ' (old)' : ''
    const range = stop?.from ? `:${stop.from}${end}${side}` : ''
    const name = el('span', 'change-file-name', `${file.path}${range}`)
    const identity = el('div', 'change-file-identity')
    identity.append(name, el('span', 'change-file-status', changeFileLabel(file)))
    const role = `${file.role}${Object.hasOwn(bundle.story?.roles ?? {}, file.path) ? ' (role override)' : ''}`
    const viewedControl = mark(id)
    viewedControl.disabled = collapsed && !navigation.isViewed(id)
    head.append(
      identity,
      el('span', 'change-role', [role, stop?.importance].filter(Boolean).join(' · ')),
      viewedControl,
    )
    card.append(head)
    if (stop?.note) card.append(prose(stop.note))
    parent.append(card)
    sectionIds.push(id)
    const body = el('div', 'change-file-body')
    card.append(body)
    const view = {
      card,
      file,
      showAll: () => {
        if (collapsed) {
          ;(card as HTMLDetailsElement).open = true
          viewedControl.disabled = false
          if (!body.childNodes.length) addDiff(body, file, hunks)
        }
      },
    }
    views.push(view)
    if (collapsed)
      card.addEventListener('toggle', () => {
        if ((card as HTMLDetailsElement).open) {
          viewedControl.disabled = false
          if (!body.childNodes.length) addDiff(body, file, hunks)
        }
      })
    else addDiff(body, file, wholeFiles.has(id) ? file.hunks : hunks)
    if (collapsed && reading.expanded.includes(id)) {
      ;(card as HTMLDetailsElement).open = true
      view.showAll()
    }
    if (stop && (stop.from !== undefined || stop.to !== undefined)) {
      let whole = wholeFiles.has(id)
      const toggle = button('Show file diff', () => {
        whole = !whole
        if (whole) wholeFiles.add(id)
        else wholeFiles.delete(id)
        toggle.textContent = whole ? 'Show chosen range' : 'Show file diff'
        for (const host of body.querySelectorAll<HTMLElement>('.change-diff-window')) {
          io.unobserve(host)
          windows.get(host)?.mounted?.dispose()
          windows.delete(host)
        }
        body.replaceChildren()
        addDiff(body, file, whole ? file.hunks : hunks)
      })
      toggle.textContent = whole ? 'Show chosen range' : 'Show file diff'
      toggle.className = 'change-range-toggle'
      card.insertBefore(toggle, body)
      view.showAll = () => {
        if (!whole) toggle.click()
      }
    }
  }
  const flags = bundle.story?.flags ?? []
  if (flags.length) {
    const box = el('aside', 'change-flags')
    box.setAttribute('aria-label', 'Look here first')
    box.append(el('h2', '', 'Look here first'))
    for (const flag of flags) {
      const jump = button(
        `${flag.file}${flag.from ? `:${flag.from}${flag.side === 'old' ? ' (old)' : ''}` : ''}`,
        () => jumpToRange(flag),
      )
      const row = el('div', 'change-flag')
      row.append(jump, prose(flag.text))
      box.append(row)
    }
    main.append(box)
  }
  const story = section(
    'Story',
    bundle.story
      ? 'The author’s reading order. Line numbers open a comment.'
      : 'No authored chapters. Read implementation first, then configuration and documentation.',
  )
  if (!bundle.story)
    for (const file of lanes.remaining)
      addFile(story.element, file, file.hunks, `file:${file.path}`, story.ids)
  for (const [chapterIndex, chapter] of lanes.chapters.entries()) {
    const part = el('section', 'change-chapter')
    part.append(el('h3', '', `${String(chapterIndex + 1).padStart(2, '0')}  ${chapter.title}`))
    part.append(prose(chapter.narrative))
    if (chapter.why_here) part.append(el('p', 'change-why', chapter.why_here))
    story.element.append(part)
    chapterHosts.set(chapter.id, part)
    const link = button(chapter.title, () => reveal(part))
    link.className = 'change-chapter-link'
    rail.append(link)
    const entry = { element: part, link, ids: [] as string[], label: chapter.title }
    part.dataset.windowId = `section:${sections.length}`
    sections.push(entry)
    for (const [index, stop] of chapter.stops.entries()) {
      const file = files.find((f) => f.path === stop.file)
      if (file) addFile(part, file, stop.hunks, `stop:${chapter.id}:${index}`, entry.ids, stop)
    }
    story.ids.push(...entry.ids)
  }
  const tests = section('Tests', 'Every test file, including tests cited in the story.')
  for (const file of lanes.tests)
    addFile(tests.element, file, file.hunks, `file:${file.path}`, tests.ids)
  if (!lanes.tests.length)
    tests.element.append(el('p', 'change-empty', 'No test files in this change.'))
  const remaining = section(
    'Remaining',
    bundle.story
      ? 'Changed lines not shown in the story, with context. Generated files start folded.'
      : 'All non-test files, ordered implementation first.',
  )
  if (bundle.story)
    for (const file of lanes.remaining)
      addFile(remaining.element, file, file.hunks, `file:${file.path}`, remaining.ids)
  if (!bundle.story || !lanes.remaining.length)
    remaining.element.append(
      el(
        'p',
        'change-empty',
        bundle.story
          ? 'Every non-test changed line is shown in the story.'
          : 'All files are included above.',
      ),
    )
  section('Your review').element.append(...review.content)
  updateProgress()
  const anchor = reading.anchor
  const anchorHosts = () => [
    ...(map ? [map] : []),
    ...windows.keys(),
    ...sections.map((section) => section.element).reverse(),
  ]
  const anchorHost = anchor && anchorHosts().find((host) => host.dataset.windowId === anchor.window)
  if (anchorHost && anchor) {
    const window = windows.get(anchorHost)
    if (window) window.mounted = mountWindow(anchorHost, window.hunk, window.file)
    reveal(anchorHost)
    navigation.anchor(
      () => windowRows(anchorHost)[anchor.row] ?? anchorHost,
      anchor.offset,
      window?.mounted?.ready ?? Promise.resolve(),
    )
  }
  return {
    scroller: scroll,
    dispose() {
      save(`${prefix}:position`, {
        expanded: [
          ...shell.querySelectorAll<HTMLDetailsElement>('details[open][data-view-id]'),
        ].map((card) => card.dataset.viewId!),
        whole: [...wholeFiles],
        anchor: readingAnchor(scroll, anchorHosts()),
      } satisfies ChangeReadingState)
      io.disconnect()
      navigation.dispose()
      map?.dispatchEvent(new Event('dispose'))
      for (const window of windows.values()) window.mounted?.dispose()
      shell.remove()
    },
  }
}
