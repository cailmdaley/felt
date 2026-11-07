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
/** The open left column's list when it has one, else the sheet. */
export async function sentFiles(page) {
  const column = page.locator('.ws-sidebar-file:visible')
  if (await column.count()) return column
  const sheet = page.locator('.ws-page-sheet[open]')
  if (!await sheet.count()) {
    if (page.viewportSize().width <= 700) await page.locator('.ws-navbar .ws-files-toggle').click()
    else {
      await page.locator('.ws-page.ws-selected .ws-menu-button').click()
      await page.locator('.ws-menu').getByRole('button', { name: 'Sent files', exact: true }).click()
    }
    await sheet.waitFor()
  }
  return sheet.locator('.ws-sent-file')
}
