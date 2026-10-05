/** CSS build tools may serialize duration tokens in seconds; JS consumes milliseconds. */
export function workspaceMeasure(element: HTMLElement, name: string, fallback: number): number {
  const value = getComputedStyle(element).getPropertyValue(`--ws-${name}`).trim()
  const number = Number.parseFloat(value)
  if (!Number.isFinite(number)) return fallback
  return value.endsWith('s') && !value.endsWith('ms') ? number * 1000 : number
}
