/** The way to a constitution's threads and sent files, from any of its pages. */
export async function familyTree(page) {
  const fold = page.locator('.ws-page.ws-selected .ws-family-all')
  if (!await fold.count()) {
    await page.evaluate(() => { document.activeElement?.blur() })
    await page.keyboard.press('l')
    await fold.waitFor()
  }
  if (!await fold.evaluate(el => el.open)) await fold.locator('summary').click()
  return fold.locator('.ws-family')
}
export async function sentFiles(page) {
  const sheet = page.locator('.ws-page-sheet[open]')
  if (!await sheet.count()) {
    const menu = page.locator(page.viewportSize().width <= 700 ? '.ws-navbar .ws-phone-document-menu' : '.ws-page.ws-selected .ws-menu-button')
    await menu.focus(); await menu.click()
    await page.getByRole('button', { name: 'Sent files', exact: true }).click()
    await sheet.waitFor()
  }
  return sheet.locator('.ws-sent-file')
}
