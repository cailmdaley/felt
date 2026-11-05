import {
  disposeHighlighter,
  registerCustomCSSVariableTheme,
  type AnnotationSide,
} from '@pierre/diffs'
import { renderMarkdown } from '../utils.js'
import {
  assignLanes,
  changeIdentity,
  reviewMessage,
  type ChangeRange,
  type ChangeBundle,
  type ChangeComment,
  type ChangeFile,
  type ChangeHunk,
  type ChangeWindow,
} from './changeModel.js'
import './change-reader.css'
import { mountChangeWindow } from './changeWindow.js'
import { validateChangeBundle } from './changeValidation.js'
import { acquireChangeDraft } from './changeDraft.js'
import { changeFileLabel } from './changeFileLabel.js'
import { readingAnchor, windowRows, type ChangeReadingState } from './changePosition.js'

registerCustomCSSVariableTheme('shuttle-change', {})
export { disposeHighlighter as releaseChangeHighlighter }
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = cls
  if (text) node.textContent = text
  return node
}
function prose(text: string): HTMLElement {
  const node = el('div', 'change-prose')
  node.innerHTML = renderMarkdown(text, { untrusted: true })
  return node
}
function revisionLabel(ref: string, sha: string): string {
  const short = sha.slice(0, 8)
  return sha.startsWith(ref) ? short : `${ref} ${short}`
}
function button(text: string, action: () => void): HTMLButtonElement {
  const node = el('button', '', text)
  node.type = 'button'
  node.addEventListener('click', action)
  return node
}
function stored<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback
  } catch {
    return fallback
  }
}
function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* Reading works without storage. */
  }
}

/** Native review content; the workspace owns its file, gestures, scroll position and worker route. */
export function mountChangeReader(
  root: HTMLElement,
  bundle: ChangeBundle,
  identity: string,
  send?: (message: string) => Promise<void>,
  canSend = () => true,
  reviewTarget = () => 'this fiber',
  revision?: string,
) {
  try {
    validateChangeBundle(bundle)
  } catch (error) {
    const message = el(
      'div',
      'change-load-error',
      error instanceof Error ? error.message : 'Invalid change bundle',
    )
    message.setAttribute('role', 'alert')
    root.replaceChildren(message)
    return {
      scroller: message,
      dispose() {
        message.remove()
      },
    }
  }
  const files = bundle.files
  const lanes = assignLanes(bundle)
  const version = revision ?? changeIdentity(JSON.stringify(bundle.story) + bundle.title)
  const prefix = `shuttle:change:${JSON.stringify([identity, bundle.base, bundle.head, version])}`
  const viewed = new Set(stored<string[]>(`${prefix}:viewed`, []))
  const reading = stored<ChangeReadingState>(`${prefix}:position`, { expanded: [], whole: [] })
  const wholeFiles = new Set(reading.whole)
  const draftState = acquireChangeDraft(identity, bundle.base, bundle.head),
    draft = draftState.value
  const shell = el('div', 'change-reader')
  const rail = el('nav', 'change-contents')
  rail.setAttribute('aria-label', 'Change contents')
  const scroll = el('div', 'change-scroll')
  scroll.tabIndex = -1
  const main = el('main', 'change-main')
  scroll.append(main)
  shell.append(rail, scroll)
  root.append(shell)
  const disposers: (() => void)[] = []
  let destination: { element: () => Element | null | undefined; offset: number } | undefined
  const alignDestination = (): void => {
    const element = destination?.element()
    if (element?.isConnected)
      scroll.scrollTop += element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - destination!.offset
  }
  const reveal = (element: Element, center = false): void => {
    destination = { element: () => element, offset: center ? scroll.clientHeight / 2 : 16 }
    alignDestination()
  }
  const releaseDestination = (): void => {
    destination = undefined
  }
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    shell.addEventListener(type, releaseDestination, { passive: true })
    disposers.push(() => shell.removeEventListener(type, releaseDestination))
  }
  const progress = el('span', 'change-progress')
  const railTitle = el('div', 'change-contents-title', 'Read the change')
  railTitle.append(progress)
  rail.append(railTitle)
  const sections: {
    element: HTMLElement
    link: HTMLButtonElement
    ids: string[]
    label: string
  }[] = []
  const marks = new Map<string, HTMLButtonElement[]>()
  const updateProgress = (): void => {
    const ids = [...marks.keys()]
    progress.textContent = `${ids.filter((id) => viewed.has(id)).length}/${ids.length}`
    for (const [id, controls] of marks)
      for (const control of controls) {
        control.setAttribute('aria-pressed', String(viewed.has(id)))
        control.textContent = viewed.has(id) ? '✓ Viewed' : 'Mark viewed'
      }
    for (const section of sections) {
      section.link.textContent = section.ids.length
        ? `${section.label}  ${section.ids.filter((id) => viewed.has(id)).length}/${section.ids.length}`
        : section.label
    }
    save(`${prefix}:viewed`, [...viewed])
  }
  const mark = (id: string): HTMLButtonElement => {
    const control = button('Mark viewed', () => {
      if (viewed.has(id)) viewed.delete(id)
      else viewed.add(id)
      updateProgress()
    })
    control.className = 'change-viewed'
    control.dataset.viewId = id
    marks.set(id, [...(marks.get(id) ?? []), control])
    return control
  }
  const section = (
    title: string,
    description?: string,
  ): { element: HTMLElement; link: HTMLButtonElement; ids: string[]; label: string } => {
    const element = el('section', 'change-section')
    element.append(el('h2', '', title))
    if (description) element.append(el('p', 'change-section-note', description))
    const link = button(title, () => reveal(element))
    rail.append(link)
    main.append(element)
    const entry = { element, link, ids: [] as string[], label: title }
    element.dataset.windowId = `section:${sections.length}`
    sections.push(entry)
    return entry
  }
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
  const flags = bundle.story?.flags ?? []
  if (flags.length) {
    const box = el('aside', 'change-flags')
    box.setAttribute('aria-label', 'Look here first')
    box.append(el('h2', '', 'Look here first'))
    const addFlag = (flag: ChangeRange, text: HTMLElement): void => {
      const jump = button(
        `${flag.file}${flag.from ? `:${flag.from}${flag.side === 'old' ? ' (old)' : ''}` : ''}`,
        () => jumpToRange(flag),
      )
      const row = el('div', 'change-flag')
      row.append(jump, text)
      box.append(row)
    }
    for (const flag of flags) addFlag(flag, prose(flag.text))
    main.append(box)
  }
  const note = el('textarea', 'change-overall')
  note.placeholder = 'Your overall note…'
  note.setAttribute('aria-label', 'Overall review note')
  note.value = draft.note
  const status = el('span', 'change-send-status')
  status.setAttribute('role', 'status')
  const reviewAnchor = el('p', 'change-section-note')
  const persist = (): void => {
    draftState.save()
    status.textContent = 'Draft saved on this browser'
  }
  note.addEventListener('input', () => {
    if (draftState.busy) return
    if (!draft.note) {
      draft.base = bundle.base
      draft.head = bundle.head
    }
    draft.note = note.value
    persist()
    paintSend()
  })
  const sendButton = button('Send review', () => {
    void deliver()
  })
  const paintSend = (): void => {
    const anchors = [
      ...(draft.note.trim() ? [draft] : []),
      ...draft.comments.filter((c) => c.text.trim()),
    ].map((value) => ({
      base: value.base ?? draft.base ?? bundle.base,
      head: value.head ?? draft.head ?? bundle.head,
    }))
    const earlier = [
      ...new Map(
        anchors
          .filter((anchor) => anchor.base !== bundle.base || anchor.head !== bundle.head)
          .map((anchor) => [JSON.stringify(anchor), anchor]),
      ).values(),
    ]
    const current = `Current base ${bundle.base.slice(0, 8)}, head ${bundle.head.slice(0, 8)}.`
    const previous = earlier
      .map((anchor) => `base ${anchor.base.slice(0, 8)}, head ${anchor.head.slice(0, 8)}`)
      .join('; ')
    const explanation = earlier.length
      ? `This draft also contains notes anchored to earlier snapshots (${previous}); Send preserves those anchors.`
      : 'Drafts stay on this browser and keep their snapshot anchors across rebakes.'
    reviewAnchor.textContent = `To ${reviewTarget()}. ${current} ${explanation}`
    sendButton.disabled =
      draftState.busy ||
      !send ||
      !canSend() ||
      !(draft.note.trim() || draft.comments.some((c) => c.text.trim()))
    sendButton.textContent = draftState.busy
      ? 'Sending…'
      : earlier.length
        ? `Send review (includes ${earlier.map((anchor) => anchor.head.slice(0, 8)).join(', ')})`
        : 'Send review'
    for (const field of shell.querySelectorAll<HTMLTextAreaElement>('textarea'))
      field.disabled = draftState.busy
    for (const control of shell.querySelectorAll<HTMLButtonElement>('.change-comment-remove'))
      control.disabled = draftState.busy
    if ((!send || !canSend()) && !draftState.message)
      status.textContent =
        'No live worker. Start or resume one from the composer before sending a review.'
  }
  const deliver = async (): Promise<void> => {
    paintSend()
    if (sendButton.disabled || !send) return
    draftState.lock(true)
    paintSend()
    try {
      await send(reviewMessage(bundle, draft))
      draft.note = ''
      draft.comments = []
      draft.base = bundle.base
      draft.head = bundle.head
      note.value = ''
      persist()
      refreshAnnotations()
      renderDraftComments()
      draftState.report('Review sent to the worker')
    } catch (error) {
      draftState.report(
        error instanceof Error ? error.message : 'Could not send review. Your draft is saved.',
      )
    } finally {
      draftState.lock(false)
      status.textContent = draftState.message
      paintSend()
    }
  }
  const annotations = new Set<ReturnType<typeof mountChangeWindow>>()
  const sideOf = (side: AnnotationSide): 'new' | 'old' => (side === 'deletions' ? 'old' : 'new')
  const lineAnnotations = (file: ChangeFile) =>
    draft.comments
      .filter(
        (c) =>
          c.file === file.path &&
          (c.head ?? draft.head ?? bundle.head) === bundle.head &&
          (c.base ?? draft.base ?? bundle.base) === bundle.base,
      )
      .map((c) => ({
        side: c.side === 'old' ? ('deletions' as const) : ('additions' as const),
        lineNumber: c.line,
        metadata: c,
      }))
  const refreshAnnotations = (): void => {
    for (const entry of annotations) entry.update()
  }
  const commentField = (comment: ChangeComment): HTMLElement => {
    const box = el('div', 'change-comment')
    const head = comment.head ?? draft.head ?? bundle.head,
      base = comment.base ?? draft.base ?? bundle.base
    const location = `${comment.file}:${comment.line}${comment.side === 'old' ? ' (old)' : ''}`
    const anchor = `base ${base.slice(0, 8)}, head ${head.slice(0, 8)}`
    const earlier = head !== bundle.head || base !== bundle.base ? ' (earlier snapshot)' : ''
    const label = el('label', '', `${location} · ${anchor}${earlier}`)
    const field = el('textarea', '')
    field.value = comment.text
    field.placeholder = 'What should the author look at?'
    field.disabled = draftState.busy
    field.dataset.commentKey = JSON.stringify([
      base,
      head,
      comment.file,
      comment.line,
      comment.side,
    ])
    field.setAttribute('aria-description', `Anchored to base ${base}, head ${head}`)
    field.setAttribute('aria-label', `Comment on ${comment.file}:${comment.line} (${comment.side})`)
    field.addEventListener('input', () => {
      if (draftState.busy) return
      comment.text = field.value
      for (const mirror of shell.querySelectorAll<HTMLTextAreaElement>('textarea')) {
        if (mirror !== field && mirror.dataset.commentKey === field.dataset.commentKey)
          mirror.value = field.value
      }
      persist()
      paintSend()
    })
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        field.blur()
      }
    })
    label.append(field)
    const remove = button('Remove', () => {
      if (draftState.busy) return
      draft.comments = draft.comments.filter((c) => c !== comment)
      persist()
      refreshAnnotations()
      renderDraftComments()
      paintSend()
    })
    remove.className = 'change-comment-remove'
    remove.disabled = draftState.busy
    box.append(label, remove)
    return box
  }
  const addComment = (file: ChangeFile, line: number, side: AnnotationSide): void => {
    if (draftState.busy) return
    let comment = draft.comments.find(
      (c) =>
        c.file === file.path &&
        c.line === line &&
        c.side === sideOf(side) &&
        (c.head ?? draft.head ?? bundle.head) === bundle.head &&
        (c.base ?? draft.base ?? bundle.base) === bundle.base,
    )
    if (!comment) {
      comment = {
        file: file.path,
        line,
        side: sideOf(side),
        text: '',
        base: bundle.base,
        head: bundle.head,
      }
      draft.comments.push(comment)
      persist()
      refreshAnnotations()
      renderDraftComments()
    }
    requestAnimationFrame(() => {
      const field = [
        ...shell.querySelectorAll<HTMLTextAreaElement>(
          '.change-file textarea, .change-draft-comments textarea',
        ),
      ].find(
        (field) =>
          field.dataset.commentKey ===
          JSON.stringify([bundle.base, bundle.head, file.path, line, sideOf(side)]),
      )
      field?.focus({ preventScroll: true })
      if (field && field.getBoundingClientRect().bottom > scroll.getBoundingClientRect().bottom)
        reveal(field, true)
    })
  }
  // The slot wrapper lives in light DOM, so workspace typography and form controls apply to comments.
  const mountWindow = (host: HTMLElement, window: ChangeWindow, file: ChangeFile) => {
    const entry = mountChangeWindow(host, window, file, {
      annotations: () => lineAnnotations(file),
      add: (line, side) => addComment(file, line, side),
      field: commentField,
    })
    annotations.add(entry)
    return {
      ready: entry.ready,
      dispose() {
        annotations.delete(entry)
        entry.dispose()
      },
    }
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
        return host.querySelector('diffs-container')?.shadowRoot?.querySelector(
          `[data-column-number="${range.from}"]:not([data-line-type="${excluded}"])`,
        ) ?? host.querySelector(`.change-plain-row[data-${range.side === 'old' ? 'old' : 'new'}-line="${range.from}"]`)
      },
      offset: scroll.clientHeight / 2,
    }
    destination = target
    void window.mounted.ready.then(() => {
      if (destination === target) alignDestination()
    })
  }
  const addDiff = (parent: HTMLElement, file: ChangeFile, hunks: ChangeHunk[]): void => {
    const slices = hunks.flatMap((hunk) => hunk.windows)
    if (!slices.length) {
      parent.append(el('pre', 'change-metadata', `${file.status} · no text hunks\n${file.header}`))
      return
    }
    for (const slice of slices) {
      const host = el('div', 'change-diff-window')
      host.dataset.windowId = JSON.stringify([parent.closest<HTMLElement>('.change-file')!.dataset.viewId, slice.start])
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
    viewedControl.disabled = collapsed && !viewed.has(id)
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
  const review = section('Your review')
  const draftComments = el('div', 'change-draft-comments')
  const renderDraftComments = (): void => {
    draftComments.replaceChildren(...draft.comments.map(commentField))
  }
  renderDraftComments()
  const foot = el('div', 'change-send')
  foot.append(sendButton, status)
  review.element.append(reviewAnchor, draftComments, note, foot)
  if (!send || !canSend())
    status.textContent =
      'No live worker. Start or resume one from the composer before sending a review.'
  paintSend()
  updateProgress()
  let railFrame = 0
  const paintLocation = (): void => {
    railFrame = 0
    const top = scroll.getBoundingClientRect().top + 100
    const active = sections
      .filter((section) => section.element.getBoundingClientRect().top <= top)
      .at(-1)
    for (const section of sections) {
      const current = section === active ? 'location' : 'false'
      if (section.link.getAttribute('aria-current') !== current)
        section.link.setAttribute('aria-current', current)
    }
  }
  const scheduleLocation = (): void => {
    if (!railFrame) railFrame = requestAnimationFrame(paintLocation)
  }
  // Keep explicit navigation anchored while nearby diff windows acquire their wrapped height.
  const locationResize = new ResizeObserver(() => {
    alignDestination()
    scheduleLocation()
  })
  locationResize.observe(scroll)
  locationResize.observe(main)
  scroll.addEventListener('scroll', scheduleLocation, { passive: true })
  scheduleLocation()
  disposers.push(
    () => io.disconnect(),
    () => {
      locationResize.disconnect()
      cancelAnimationFrame(railFrame)
      scroll.removeEventListener('scroll', scheduleLocation)
    },
  )
  rail.addEventListener('keydown', (event) => {
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
    )
      return
    const links = [...rail.querySelectorAll('button')],
      index = links.indexOf(event.target as HTMLButtonElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? links.length - 1
          : Math.max(
              0,
              Math.min(
                links.length - 1,
                index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1),
              ),
            )
    event.preventDefault()
    event.stopPropagation()
    links[next]?.focus()
  })
  const stopKeys = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && (event.target as Element)?.matches('textarea')) {
      event.preventDefault()
      event.stopPropagation()
      ;(event.target as HTMLElement).blur()
    }
  }
  shell.addEventListener('keydown', stopKeys)
  const anchor = reading.anchor
  const anchorHosts = () => [...windows.keys(), ...sections.map(section => section.element).reverse()]
  const anchorHost = anchor && anchorHosts().find(host => host.dataset.windowId === anchor.window)
  if (anchorHost && anchor) {
    const window = windows.get(anchorHost)
    if (window) window.mounted = mountWindow(anchorHost, window.hunk, window.file)
    destination = { element: () => windowRows(anchorHost)[anchor.row] ?? anchorHost, offset: anchor.offset }
    alignDestination()
    void window?.mounted?.ready.then(alignDestination)
  }
  return {
    scroller: scroll,
    dispose() {
      save(`${prefix}:position`, {
        expanded: [...shell.querySelectorAll<HTMLDetailsElement>('details[open][data-view-id]')].map(card => card.dataset.viewId!),
        whole: [...wholeFiles],
        anchor: readingAnchor(scroll, anchorHosts()),
      } satisfies ChangeReadingState)
      for (const dispose of disposers) dispose()
      for (const window of windows.values()) window.mounted?.dispose()
      shell.remove()
    },
  }
}
