/**
 * The way to a constitution's threads and sent files, from any of its pages:
 * its family's page, with every fold that holds a thread opened by the keys,
 * which leave Rex alone.
 */
export async function familyTree(page) {
  const shown = page.locator('.ws-page.ws-selected'), tree = shown.locator('.fp-tree')
  await shown.waitFor()
  if (!(await shown.getAttribute('data-key')).startsWith('family:')) {
    await page.evaluate(() => { document.activeElement?.blur() })
    await page.keyboard.press('l')
  }
  await tree.locator('.fp-row').first().waitFor()
  for (let n = 0; n < 40; n++) {
    const closed = tree.locator('.fp-aside[aria-expanded="false"], .fp-row[aria-expanded="false"]:has(.fp-count:not(:empty))').first()
    if (!await closed.count()) break
    await closed.focus()
    await page.keyboard.press('ArrowRight')
  }
  return tree
}
/** A thread's row on its family's page, by its exact name, which its slug carries as a tooltip. */
export const threadRow = (page, tree, name) => tree.locator('.fp-row').filter({ has: page.locator(`.fp-name[title="${name}"]`) })
/**
 * Opens a thread's own page from its row: the activation unfolds the row in
 * place (a second one when the first folded it), and the constitution it
 * holds opens the page. The head is always unfolded. Keys rather than clicks,
 * so a phone's top bar sliding as the page scrolls never moves the target.
 */
export async function openThread(page, row, name, activate = target => target.press('Enter')) {
  if (await row.getAttribute('aria-expanded') !== null) {
    await activate(row)
    if (await row.getAttribute('aria-expanded') === 'false') await activate(row)
  }
  await row.locator('[data-kind="constitution"]').press('Enter')
  await page.waitForFunction(name => document.querySelector('.ws-stage-band .ws-band-title')?.textContent === name, name)
}
/** The sent files, in the sheet the bar's toggle opens. */
export async function sentFiles(page) {
  const sheet = page.locator('.ws-page-sheet[open]')
  if (!await sheet.count()) {
    await page.locator('.ws-files-toggle:visible').click()
    await sheet.waitFor()
  }
  return sheet.locator('.ws-sent-file')
}
