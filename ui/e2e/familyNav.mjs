/** The way to a constitution's threads and sent files, from any of its pages. */
export async function familyTree(page) {
  const fold = page.locator('.ws-page.ws-selected .ws-family-all')
  if (!await fold.count()) {
    await page.evaluate(() => { document.activeElement?.blur() })
    await page.keyboard.press('l')
    await fold.waitFor()
  }
  if (!await fold.evaluate(el => el.open)) await fold.locator('.ws-family-all-label').click()
  await fold.evaluate(el => { for (const inner of el.querySelectorAll('details')) inner.open = true })
  return fold.locator('.ws-family')
}
/**
 * Opens a thread's own page from its row in the family's tree. A row comes to a
 * thread the map draws, leaving the page standing, and that thread's scene holds
 * the way to its constitution; a thread the map has no place for opens at once.
 */
export async function openThread(page, row, name, activate = target => target.click()) {
  await activate(row)
  await page.waitForFunction(name => document.querySelector('.ws-stage-band .ws-band-title')?.textContent === name
    || document.querySelector('.ws-page.ws-selected .ws-family-peek-name')?.textContent === name, name)
  if (await page.locator('.ws-stage-band .ws-band-title').textContent() !== name) {
    await page.locator('.ws-page.ws-selected .fm-held:visible').filter({ hasText: 'Constitution' }).click()
    await page.waitForFunction(name => document.querySelector('.ws-stage-band .ws-band-title')?.textContent === name, name)
  }
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
