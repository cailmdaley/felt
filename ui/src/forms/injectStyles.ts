/**
 * Append a stylesheet to `<head>` once, keyed by element id. Every form sheet
 * is injected through here on open, so calling it again is free.
 */
export function injectStyles(id: string, css: string): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(id)) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = css
  document.head.appendChild(style)
}
