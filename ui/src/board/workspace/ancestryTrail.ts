import './ancestry-trail.css'

export interface Ancestor { name: string; open(): void }

/**
 * A thread's ancestry as one quiet line of links, the family's head first:
 * `cmbx chair / MR !7 validation`. The open thread is named by its title, so
 * the trail stops at its parent. Hidden when there is nothing above.
 */
export function paintAncestry(el: HTMLElement, ancestors: readonly Ancestor[]): void {
  el.classList.add('ws-ancestry')
  el.setAttribute('aria-label', 'Orchestrators')
  const parts: HTMLElement[] = []
  ancestors.forEach(({ name, open }, i) => {
    if (i) {
      const sep = document.createElement('span'); sep.className = 'ws-ancestry-sep'; sep.textContent = '/'; sep.setAttribute('aria-hidden', 'true')
      parts.push(sep)
    }
    const link = document.createElement('button'); link.type = 'button'; link.className = 'ws-ancestry-link'
    link.textContent = name; link.title = i === ancestors.length - 1 ? `${name} · b` : name
    link.addEventListener('click', () => open())
    parts.push(link)
  })
  el.replaceChildren(...parts)
  el.hidden = !ancestors.length
}
