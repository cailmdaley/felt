import { renderMarkdown } from '../utils.js'

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = cls
  if (text) node.textContent = text
  return node
}
export function prose(text: string): HTMLElement {
  const node = el('div', 'change-prose')
  node.innerHTML = renderMarkdown(text, { untrusted: true })
  return node
}
export function revisionLabel(ref: string, sha: string): string {
  const short = sha.slice(0, 8)
  return sha.startsWith(ref) ? short : `${ref} ${short}`
}
export function button(text: string, action: () => void): HTMLButtonElement {
  const node = el('button', '', text)
  node.type = 'button'
  node.addEventListener('click', action)
  return node
}
export function stored<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback
  } catch {
    return fallback
  }
}
export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* Reading works without storage. */
  }
}
