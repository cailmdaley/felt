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
/** The sent files, in the sheet the bar's toggle opens. */
export async function sentFiles(page) {
  const sheet = page.locator('.ws-page-sheet[open]')
  if (!await sheet.count()) {
    await page.locator(page.viewportSize().width <= 700 ? '.ws-navbar .ws-files-toggle' : '.ws-page.ws-selected .ws-files-toggle').click()
    await sheet.waitFor()
  }
  return sheet.locator('.ws-sent-file')
}
