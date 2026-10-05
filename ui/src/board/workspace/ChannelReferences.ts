import { documentLabelMetadata, normalizeAbsolutePath, type WorkspaceDocument } from './documents.js'
import './references.css'

export interface ReferenceTarget { candidate: string; title: string; audio: boolean }
export interface ReferencePlayback { candidate: string; playing: boolean; progress: number }
export interface ReferenceSurface {
  resolve(targets: ReferenceTarget[]): void
  playback(state: ReferencePlayback): void
  scan(): void
  dispose(): void
}

/** Hrefs carry ./ when relative; bare code/text candidates require channel-wide uniqueness. */
export function resolveChannelReference(candidate: string, source: WorkspaceDocument, documents: readonly WorkspaceDocument[]): WorkspaceDocument | undefined {
  if (!candidate || candidate.length > 4096 || /[\u0000-\u001f]/.test(candidate) || /^[a-z][a-z\d+.-]*:/i.test(candidate) || candidate.startsWith('//') || candidate.startsWith('#')) return
  const path = candidate.split(/[?#]/)[0]
  let decoded: string
  try { decoded = decodeURIComponent(path) } catch { return }
  const matches = decoded.includes('/')
    ? documents.filter(doc => doc.owner === source.owner && doc.path === normalizeAbsolutePath(decoded, source.path.slice(0, source.path.lastIndexOf('/')) || '/'))
    : documents.filter(doc => doc.path.split('/').at(-1) === decoded)
  return matches.length === 1 ? matches[0] : undefined
}

/** Dependency-free so the opaque report can run the same scanner as local prose. */
export function referenceRuntime(root: Document | HTMLElement,
  request: (candidates: string[]) => void,
  intent: (type: 'select' | 'play' | 'pause', candidate: string) => void,
  localFileLinks = false,
): ReferenceSurface {
  type Entry = { element: HTMLElement; candidates: string[]; title: string | null; target?: ReferenceTarget; link?: HTMLAnchorElement; button?: HTMLButtonElement }
  const events = root.nodeType === 9 ? (root as Document).defaultView ?? root : root
  const entries = new Map<HTMLElement, Entry>()
  const playing = new Map<string, ReferencePlayback>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const editable = (element: Element): boolean => !!element.closest('input,textarea,select,[role="textbox"],[contenteditable]:not([contenteditable="false"]),.ws-dock')
  const relative = (value: string): string | undefined => {
    if (!value || value.startsWith('#') || value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value)) return
    return value.startsWith('/') || value.startsWith('.') ? value : `./${value}`
  }
  const candidatesFor = (element: HTMLElement): string[] => {
    if (editable(element) || element.closest('[data-shuttle-reference-control]')) return []
    if (element.tagName === 'CODE') {
      if (element.closest('a:not([data-ws-reference])') || element.closest('pre') && !element.classList.contains('md-inline-code') || element.querySelector('code')) return []
      return [element.textContent?.trim() ?? ''].filter(Boolean)
    }
    const link = element as HTMLAnchorElement
    if (link.hasAttribute('download') || link.classList.contains('kbn-wikilink') || link.dataset.fiber) return []
    const href = localFileLinks && link.dataset.filePath ? link.dataset.filePath : relative(link.getAttribute('href') ?? '')
    if (!href) return []
    return [...new Set([href, link.textContent?.trim() ?? ''].filter(Boolean))]
  }
  const clear = (entry: Entry): void => {
    entry.button?.remove(); entry.button = undefined
    if (entry.link && entry.link !== entry.element) entry.link.replaceWith(entry.element)
    if (entry.link) {
      entry.link.classList.remove('ws-channel-reference')
      delete entry.link.dataset.wsReference
      if (entry.title === null) entry.link.removeAttribute('title')
      else entry.link.title = entry.title
    }
    entry.link = undefined; entry.target = undefined
  }
  const paintPlayback = (entry: Entry): void => {
    if (!entry.button || !entry.target) return
    const state = playing.get(entry.target.candidate)
    const on = state?.playing === true
    const glyph = on ? '❙❙' : '▸'
    if (entry.button.textContent !== glyph) entry.button.textContent = glyph
    entry.button.setAttribute('aria-label', `${on ? 'Pause' : 'Play'} ${entry.target.title}`)
    entry.button.setAttribute('aria-pressed', String(on))
    entry.button.style.setProperty('--ws-reference-progress', `${Math.max(0, Math.min(1, state?.progress ?? 0)) * 100}%`)
  }
  const surface: ReferenceSurface = {
    scan() {
      if (disposed) return
      for (const [element, entry] of entries) if (!root.contains(element)) { clear(entry); entries.delete(element) }
      for (const element of root.querySelectorAll<HTMLElement>('code,a[href]')) {
        if (element.dataset.wsReference && !entries.has(element)) continue
        const candidates = candidatesFor(element)
        const old = entries.get(element)
        if (candidates.length) {
          if (old) old.candidates = candidates
          else entries.set(element, { element, candidates, title: element.getAttribute('title') })
        }
        else if (old) { clear(old); entries.delete(element) }
      }
      request([...new Set([...entries.values()].flatMap(entry => entry.candidates))])
    },
    resolve(targets) {
      if (disposed) return
      const resolved = new Map(targets.map(target => [target.candidate, target]))
      for (const entry of entries.values()) {
        const target = entry.candidates.map(candidate => resolved.get(candidate)).find(Boolean)
        if (!target) { if (entry.target) clear(entry); continue }
        if (!entry.link) {
          const link = entry.element.tagName === 'A' ? entry.element as HTMLAnchorElement : document.createElement('a')
          if (link !== entry.element) { entry.element.replaceWith(link); link.append(entry.element); link.href = '#channel-page' }
          entry.link = link
          link.classList.add('ws-channel-reference'); link.dataset.wsReference = 'true'
        }
        entry.target = target
        entry.link.title = target.title
        if (target.audio && !entry.button) {
          const button = document.createElement('button'); button.type = 'button'
          button.className = 'ws-reference-play'; button.dataset.shuttleReferenceControl = 'true'
          entry.link.before(button); entry.button = button
        } else if (!target.audio) { entry.button?.remove(); entry.button = undefined }
        paintPlayback(entry)
      }
    },
    playback(state) { playing.set(state.candidate, state); for (const entry of entries.values()) paintPlayback(entry) },
    dispose() { disposed = true; clearTimeout(timer); observer.disconnect(); events.removeEventListener('click', click); for (const entry of entries.values()) clear(entry); entries.clear() },
  }
  const click = (event: Event): void => {
    const mouse = event as MouseEvent
    if (event.defaultPrevented || mouse.button !== 0 || mouse.metaKey || mouse.ctrlKey || mouse.altKey || mouse.shiftKey) return
    const target = event.target as Element
    for (const entry of entries.values()) {
      if (!entry.target || editable(entry.element)) continue
      if (entry.button?.contains(target)) {
        event.preventDefault(); event.stopPropagation()
        intent(playing.get(entry.target.candidate)?.playing ? 'pause' : 'play', entry.target.candidate); return
      }
      if (entry.link?.contains(target)) {
        event.preventDefault(); event.stopPropagation(); intent('select', entry.target.candidate); return
      }
    }
  }
  events.addEventListener('click', click)
  const observer = new MutationObserver(() => {
    if (timer || disposed) return
    timer = setTimeout(() => { timer = undefined; surface.scan() }, 100)
  })
  observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href', 'contenteditable'] })
  return surface
}

export function referenceTargets(candidates: string[], source: WorkspaceDocument, documents: readonly WorkspaceDocument[]): ReferenceTarget[] {
  return candidates.flatMap(candidate => {
    const target = resolveChannelReference(candidate, source, documents)
    return target ? [{ candidate, title: documentLabelMetadata(target, target.name, source.owner).title || target.name, audio: target.kind === 'audio' }] : []
  })
}
