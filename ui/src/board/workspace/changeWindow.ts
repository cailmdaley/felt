import { FileDiff, getSharedHighlighter, parsePatchFiles, type AnnotationSide, type DiffLineAnnotation } from '@pierre/diffs'
import type { ChangeComment, ChangeFile, ChangeWindow } from './changeModel.js'
import { changeLanguage } from './changeLanguages.js'

interface WindowComments {
  annotations: () => DiffLineAnnotation<ChangeComment>[]
  add: (line: number, side: AnnotationSide) => void
  field: (comment: ChangeComment) => HTMLElement
}

/** Captured rows are readable without the optional parser, highlighter or grammar chunks. */
export function mountChangeWindow(host: HTMLElement, window: ChangeWindow, file: ChangeFile, comments: WindowComments) {
  let disposed = false, diff: FileDiff<ChangeComment> | undefined
  const plain = document.createElement('div'); plain.className = 'change-plain-window'
  if (window.lines) {
    for (const line of window.lines) {
      const row = document.createElement('div'); row.className = 'change-plain-row'
      row.dataset.lineType = line.kind === 'addition' ? 'change-addition' : line.kind === 'deletion' ? 'change-deletion' : line.kind === 'note' ? 'metadata' : 'context'
      row.dataset.oldLine = String(line.old); row.dataset.newLine = String(line.new)
      for (const [number, side] of [[line.old, 'deletions'], [line.new, 'additions']] as const) {
        const gutter = document.createElement('button'); gutter.type = 'button'; gutter.className = 'change-plain-number'
        gutter.textContent = number ? String(number) : ''; gutter.disabled = !number
        if (number) gutter.setAttribute('aria-label', `Comment on ${file.path}:${number} (${side === 'deletions' ? 'old' : 'new'})`)
        gutter.addEventListener('click', () => comments.add(number, side)); row.append(gutter)
      }
      const text = document.createElement('span'); text.dataset.lineText = ''; text.textContent = line.text
      row.append(text); plain.append(row)
    }
  } else {
    const raw = document.createElement('pre'); raw.textContent = window.patch; plain.append(raw)
  }
  const enhanced = document.createElement('div'); enhanced.className = 'change-highlighted-window'; enhanced.hidden = true
  const notice = document.createElement('p'); notice.className = 'change-window-notice'; notice.setAttribute('role', 'status')
  host.append(plain, enhanced); host.dataset.renderState = 'plain'
  const fallback = (): void => {
    plain.hidden = false; enhanced.hidden = true
    host.dataset.renderState = window.lines ? 'plain' : 'error'
    notice.textContent = window.lines ? `Syntax highlighting unavailable for ${file.path}; showing plain text.` : `Could not render ${file.path}; the captured patch is shown below.`
    if (!window.lines) notice.setAttribute('role', 'alert')
    host.prepend(notice)
  }
  const display = (): void => {
    const rows = enhanced.querySelector('diffs-container')?.shadowRoot?.querySelectorAll('[data-line]')
    const count = window.lines?.filter(line => line.kind !== 'note').length
    if (!rows?.length || (count !== undefined && rows.length !== count)) { fallback(); return }
    plain.hidden = true; enhanced.hidden = false; notice.remove(); host.dataset.renderState = 'highlighted'
  }
  const ready = (async () => {
    try {
      const parsed = parsePatchFiles(window.patch)[0]?.files[0]
      if (!parsed) throw new Error('Patch did not parse')
      parsed.lang = changeLanguage(file.path)
      await getSharedHighlighter({ langs: [parsed.lang], themes: ['shuttle-change'] })
      if (disposed) return
      diff = new FileDiff<ChangeComment>({ theme: 'shuttle-change', themeType: 'dark', diffStyle: 'unified', overflow: 'wrap',
        disableErrorHandling: true, disableFileHeader: true, disableVirtualizationBuffers: true, hunkSeparators: 'metadata',
        lineHoverHighlight: 'both', onLineNumberClick: props => comments.add(props.lineNumber, props.annotationSide),
        enableGutterUtility: true, onGutterUtilityClick: range => comments.add(range.start, range.side ?? 'additions'),
        renderAnnotation: annotation => comments.field(annotation.metadata), onPostRender: display,
        unsafeCSS: ':host { --diffs-font-family: var(--font-mono); --diffs-font-size: var(--type-code-block); --diffs-line-height: 20px; }',
      })
      diff.render({ fileDiff: parsed, containerWrapper: enhanced, lineAnnotations: comments.annotations() })
      display()
    } catch { if (!disposed) fallback() }
  })()
  return {
    ready,
    update(): void {
      try { diff?.render({ lineAnnotations: comments.annotations() }) } catch { fallback() }
    },
    dispose(): void { disposed = true; diff?.cleanUp(); host.replaceChildren() },
  }
}
