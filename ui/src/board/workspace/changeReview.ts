import type { AnnotationSide } from '@pierre/diffs'
import { acquireChangeDraft } from './changeDraft.js'
import {
  reviewMessage,
  type ChangeBundle,
  type ChangeFile,
  type ChangeComment,
} from './changeModel.js'
import { mountChangeWindow } from './changeWindow.js'
import { el, button } from './changeElements.js'

/** The review draft, its mirrored line comments, and delivery to the worker. */
export function createChangeReview(
  shell: HTMLElement,
  scroll: HTMLElement,
  bundle: ChangeBundle,
  identity: string,
  reveal: (element: Element, center?: boolean) => void,
  send: ((message: string) => Promise<void>) | undefined,
  canSend: () => boolean,
  reviewTarget: () => string,
) {
  const draftState = acquireChangeDraft(identity, bundle.base, bundle.head)
  const draft = draftState.value
  const counts: { file: ChangeFile; element: HTMLElement }[] = []
  const paintCounts = () => {
    for (const { file, element } of counts) {
      const n = draft.comments.filter(c => c.file === file.path).length
      element.textContent = n ? `${n} comment${n === 1 ? '' : 's'}` : ''
      element.hidden = !n
    }
  }
  const dock = el('aside', 'change-review-dock')
  dock.setAttribute('aria-label', 'Your review')
  const count = el('span', 'change-review-count')
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
    paintCounts()
    const n = draft.comments.length
    count.textContent = `${n} comment${n === 1 ? '' : 's'}`
    dock.dataset.empty = String(!draft.note.trim() && !n)
    draftComments.hidden = !n
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
    dock.title = reviewAnchor.textContent
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
      paintSend()
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
  const draftComments = el('div', 'change-draft-comments')
  const renderDraftComments = (): void => {
    draftComments.replaceChildren(...draft.comments.map(commentField))
  }
  renderDraftComments()
  const foot = el('div', 'change-send')
  foot.append(count, sendButton, status)
  dock.append(reviewAnchor, note, foot)
  paintSend()
  return {
    content: [draftComments],
    dock,
    commentCount(file: ChangeFile, element: HTMLElement) {
      counts.push({ file, element })
      paintCounts()
    },
    windowComments(file: ChangeFile) {
      return {
        annotations: () => lineAnnotations(file),
        add: (line: number, side: AnnotationSide) => addComment(file, line, side),
        field: commentField,
      }
    },
    track(entry: ReturnType<typeof mountChangeWindow>) {
      annotations.add(entry)
      return {
        ready: entry.ready,
        dispose() {
          annotations.delete(entry)
          entry.dispose()
        },
      }
    },
  }
}
