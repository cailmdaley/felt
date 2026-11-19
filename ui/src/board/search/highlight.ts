import { pieces } from './match.js'

/** The class every mark the highlighter writes carries, so the next query can take them out. */
export const FOUND_MARK = 'kbn-ch-found-text'

/** Takes out the marks a highlight left in `root`, leaving its text as it was. */
export function unhighlight(root: Element): void {
  for (const mark of root.querySelectorAll(`mark.${FOUND_MARK}`)) {
    const parent = mark.parentNode!
    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark)
    parent.normalize()
  }
}

/** Marks every place `needle` (lowercased) stands in the text under `root`, rendered markup and all; true when it found one. */
export function highlight(root: Element, needle: string): boolean {
  if (!needle) return false
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent?.toLowerCase().includes(needle)) texts.push(node as Text)
  for (const text of texts) {
    const parts = pieces(text.textContent ?? '', needle).map(part => {
      if (!part.hit) return document.createTextNode(part.text)
      const mark = document.createElement('mark')
      mark.className = FOUND_MARK
      mark.textContent = part.text
      return mark
    })
    text.replaceWith(...parts)
  }
  return texts.length > 0
}
