import { renderMarkdown, type RenderMarkdownOptions } from '../utils.js'
import { drawMermaid } from './changeMermaid.js'

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
/**
 * A story's Markdown, trusted like a fiber body: agents wrote it for one reader.
 * Relative images and links resolve beside the bundle, and mermaid fences draw.
 */
export function prose(text: string, markdown: RenderMarkdownOptions = {}): HTMLElement {
  const node = el('div', 'change-prose')
  node.innerHTML = renderMarkdown(text, markdown)
  drawMermaid(node)
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
