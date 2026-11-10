/**
 * Reading and pressing a fiber's lifecycle verbs as a person does: the verb
 * button's face, and the rest by opening its caret's menu (Escape closes it).
 * The journeys' counterpart of src/board/workspace/testActs.ts.
 */

/** The open verb menu, a portal on the body. */
export const verbMenu = page => page.locator('[role="menu"].kbn-verb-menu')
/** The face of a fiber's verb button: the verb that fits its state. */
export const verbFace = acts => acts.locator('.ws-acts-verbs > .ws-verb-face')
/** The caret on the same pill, which opens the rest. */
export const verbCaret = acts => acts.locator('.ws-acts-verbs > .ws-verb-more')

async function openMenu(acts) {
  const menu = verbMenu(acts.page())
  if (!await menu.isVisible()) await verbCaret(acts).click()
  await menu.waitFor()
  return menu
}

/** Closes an open verb menu with Escape. */
export async function closeVerbMenu(page) {
  const menu = verbMenu(page)
  if (!await menu.count()) return
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached' })
}

/** The verbs the acts offer, the face's first, as each names itself. */
export async function offeredVerbs(acts) {
  const verbs = []
  const face = verbFace(acts)
  if (await face.isVisible()) verbs.push(await face.getAttribute('data-verb'))
  if (!await verbCaret(acts).isVisible()) return verbs
  const menu = await openMenu(acts)
  verbs.push(...await menu.locator('[role="menuitem"]').evaluateAll(items => items.map(item => item.dataset.verb)))
  await closeVerbMenu(acts.page())
  return verbs
}

/**
 * The control that runs the verb named `word`: the face when it wears it,
 * else its item in the caret's menu, which this opens.
 */
export async function verbControl(acts, word) {
  const face = verbFace(acts)
  if (await face.isVisible() && await face.getAttribute('data-verb') === word) return face
  const menu = await openMenu(acts)
  return menu.locator(`[role="menuitem"][data-verb="${word}"]`)
}

/** Presses the verb its acts name `word`: on the face, or from the caret's menu. */
export async function pressVerb(acts, word) {
  await (await verbControl(acts, word)).click()
}

/**
 * The box a control answers taps in, through its centre column: its drawing,
 * grown by whatever (a ::before) widens its hit area.
 */
export async function hitBox(control) {
  return control.evaluate(el => {
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2
    let top = r.top, bottom = r.bottom
    while (el.contains(document.elementFromPoint(x, top - 1))) top--
    while (el.contains(document.elementFromPoint(x, bottom))) bottom++
    return { x: r.left, width: r.width, y: top, height: bottom - top }
  })
}
