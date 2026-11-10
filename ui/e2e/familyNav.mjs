import assert from 'node:assert/strict'

/**
 * The way to a constitution's threads and sent files, from any of its pages:
 * its family's page, with every fold that holds a thread opened by the keys.
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
    await page.keyboard.press('Enter')
  }
  return tree
}
/** A thread's row on its family's page, by its exact name, which its slug carries as a tooltip. */
export const threadRow = (page, tree, name) => tree.locator('.fp-row').filter({ has: page.locator(`.fp-name[title="${name}"]`) })
/** Enter a thread at its row without leaving the family's page. */
export async function openThread(page, row, name, activate = target => target.press('Enter')) {
  await activate(row)
  assert.equal(await row.getAttribute('aria-selected'), 'true', `${name} is selected`)
}
/**
 * Shows one of the open constitution's files as the reader's page. The reader
 * holds a receded page for each file the constitution has sent or linked, and
 * a click on a receded page visits it, as a pointer on a neighbour does.
 */
export async function showFile(page, suffix) {
  const file = page.locator(`.ws-page[data-key$="${suffix}"]`).first()
  await file.dispatchEvent('click')
  await file.and(page.locator('.ws-selected')).waitFor()
}
/** The sent files, in the sheet the phone's top bar opens. */
export async function sentFiles(page) {
  const sheet = page.locator('.ws-page-sheet[open]')
  if (!await sheet.count()) {
    await page.locator('.ws-navbar .ws-files-toggle').click()
    await sheet.waitFor()
  }
  return sheet.locator('.ws-sent-file')
}
/** Back a page: the phone's top bar holds the way back, the band elsewhere. */
export async function pageBack(page) {
  const phone = page.viewportSize().width <= 700
  await page.locator(phone ? '.ws-navbar .ws-return' : '.ws-stage-band [data-part="band-back"]').click()
}
/** A thread's sent files on its family's page, its row's sends segment unfolded, newest send first. */
export async function familySends(page, row = page.locator('.ws-page.ws-selected .fp-head')) {
  const all = row.locator('.fp-sent')
  if (await all.getAttribute('aria-expanded') !== 'true') await all.click()
  return row.locator('.fp-files .fp-file')
}
