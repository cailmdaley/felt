import assert from 'node:assert/strict'

/**
 * The open constitution's view, from any of its pages: its orchestrators
 * above, its head, its strip and its threads.
 */
export async function familyTree(page) {
  const shown = page.locator('.ws-page.ws-selected')
  await shown.waitFor()
  if (!(await shown.getAttribute('data-key')).startsWith('family:')) {
    await page.evaluate(() => { document.activeElement?.blur() })
    await page.keyboard.press('l')
  }
  const view = shown.locator('.ws-family-page')
  await view.locator('.ov-head').waitFor()
  return view
}
/** A thread's row in a constitution's view, by its slug. */
export const threadRow = (page, view, slug) => view.locator('.ov-thread').filter({ has: page.locator('.thread-row-slug').getByText(slug, { exact: true }) })
/** Opens a thread's own view from its row. */
export async function openThread(page, row, name, activate = target => target.click()) {
  await activate(row)
  await page.locator(`.ws-page.ws-selected .ov-head[title="${name}"]`).waitFor()
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
/** The open list of files: a count's, a bar's or the phone's top bar's. */
export const fileList = page => page.locator('.kbn-conversation-menu:has(.uf-file-row)')
/** The sent files, in the list the phone's top bar opens. */
export async function sentFiles(page) {
  const rows = fileList(page).locator('.uf-file-row')
  if (!await rows.count()) {
    await page.locator('.ws-navbar .ws-files-toggle').click()
    await rows.first().waitFor()
  }
  return rows
}
/** The reader's back, one step to the view it was opened from: the phone's top bar holds it, the selected page's label bar elsewhere. */
export async function pageBack(page) {
  const phone = page.viewportSize().width <= 700
  await page.locator(phone ? '.ws-navbar .ws-return' : '.ws-page.ws-selected .ws-document-back').click()
}
/** The open constitution's sent files, from its view's head: its count lists them, and the newest opens in the reader. */
export async function familySends(page) {
  await page.locator('.ws-page.ws-selected .ov-head [data-part="sends"]').click()
  await fileList(page).locator('.uf-file-row').first().click()
}
