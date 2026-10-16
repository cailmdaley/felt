import { APPEARANCE_CHANGED } from '../appearance.js'

let snapshots = new WeakMap<HTMLElement, Map<string, string>>()

/**
 * Forget an element's stylesheet-token snapshot, or every snapshot. Whoever
 * changes a token's inputs calls it as it writes them: the appearance, a
 * channel theme (`ChannelThemes`), the board's bar geometry (`KanbanModal`)
 * and the reader's own layout modes.
 */
export function invalidateWorkspaceMeasures(element?: HTMLElement): void {
  if (element) snapshots.delete(element)
  else snapshots = new WeakMap()
}
if (typeof window !== 'undefined') window.addEventListener(APPEARANCE_CHANGED, () => invalidateWorkspaceMeasures())

/** Read the workspace's stylesheet constants together, before interaction writes dirty its style. */
export function workspaceToken(element: HTMLElement, name: string): string {
  let tokens = snapshots.get(element)
  if (!tokens) {
    const style = getComputedStyle(element)
    tokens = new Map()
    for (let i = 0; i < style.length; i++) {
      const property = style.item(i)
      if (property.startsWith('--ws-')) tokens.set(property.slice(5), style.getPropertyValue(property).trim())
    }
    if (element.isConnected) snapshots.set(element, tokens)
  }
  return tokens.get(name) ?? ''
}

/** CSS build tools may serialize duration tokens in seconds; JS consumes milliseconds. */
export function workspaceMeasure(element: HTMLElement, name: string, fallback: number): number {
  const value = workspaceToken(element, name)
  const number = Number.parseFloat(value)
  if (!Number.isFinite(number)) return fallback
  return value.endsWith('s') && !value.endsWith('ms') ? number * 1000 : number
}
