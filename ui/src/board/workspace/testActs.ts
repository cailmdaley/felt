/**
 * Reading and pressing a fiber's verbs as a person does: the verb button's
 * face, and the rest by opening its caret's menu. For tests.
 */

const menuItems = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')]
const dismiss = (): void => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) }

/** The verbs a fiber's acts offer, the face's first, as each names itself. */
export function offeredVerbs(acts: Element): string[] {
  const pill = acts.querySelector<HTMLElement>('.ws-acts-verbs')
  if (!pill || pill.hidden) return []
  const face = pill.querySelector<HTMLButtonElement>('.ws-verb-face:not([hidden])')
  const more = pill.querySelector<HTMLButtonElement>('.ws-verb-more:not([hidden])')
  const verbs = face ? [face.dataset.verb!] : []
  if (!more) return verbs
  more.click()
  verbs.push(...menuItems().map(item => item.dataset.verb!))
  dismiss()
  return verbs
}

/** Presses the verb its acts name `label`: on the face, or from the caret's menu. */
export function pressVerb(acts: Element, label: string): void {
  const face = acts.querySelector<HTMLButtonElement>('.ws-verb-face:not([hidden])')
  if (face?.dataset.verb === label) { face.click(); return }
  acts.querySelector<HTMLButtonElement>('.ws-verb-more')!.click()
  const item = menuItems().find(item => item.dataset.verb === label)
  if (!item) { dismiss(); throw new Error(`no verb ${label} among ${offeredVerbs(acts).join(', ')}`) }
  item.click()
}
