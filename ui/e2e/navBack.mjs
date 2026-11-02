import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=nav-back`
const selected = page => page.locator('.ws-page.ws-selected')
const heading = (page, name) => selected(page).getByRole('heading', { name, exact: true })

export function registerNavigationJourneys(test) {
  for (const [device, viewport, phone] of [
    ['phone', { width: 390, height: 844 }, true],
    ['desktop', { width: 1440, height: 900 }, false],
  ]) test(`Visited-path navigation (${device}): nested Desk landing, sibling, file, reload, Back and deep link`, async page => {
    const shot = async name => {
      if (!process.env.NAV_BACK_SHOTS) return
      await mkdir(process.env.NAV_BACK_SHOTS, { recursive: true })
      await page.screenshot({ path: resolve(process.env.NAV_BACK_SHOTS, `${device}-${name}.png`) })
    }
    const checkBack = async (label, chat) => {
      const control = chat ? selected(page).locator('.ws-chat-origin') : phone ? page.locator('.ws-return') : selected(page).locator('.ws-document-back')
      assert.equal(await control.getAttribute('aria-label'), `Back to ${label}`)
      assert.equal(await control.getAttribute('title'), `Back to ${label}`)
      assert.ok(await control.isVisible())
      if (phone && chat) {
        const bounds = await selected(page).locator('.ws-chat-head').evaluate(head => {
          const back = head.querySelector('.ws-chat-origin').getBoundingClientRect()
          const title = head.querySelector('.ws-chat-identity').getBoundingClientRect()
          return { backRight: back.right, titleLeft: title.left, titleWidth: title.width }
        })
        assert.ok(bounds.backRight <= bounds.titleLeft && bounds.titleWidth > 80, JSON.stringify(bounds))
      }
      return control
    }
    await page.goto(url + '#/desk')
    await page.locator('.kbn-desk .kbn-card').filter({ hasText: 'Calibrate the shear response' }).click()
    await heading(page, 'Choose the response cut').waitFor()
    await checkBack('Desk', true)
    await shot('01-nested-from-desk')
    if (phone) await page.locator('.ws-rail-toggle').click()
    const rows = page.locator(phone ? '.ws-page-sheet[open] .kbn-thread-row' : '.ws-thread-rail .kbn-thread-row')
    await rows.filter({ hasText: 'Review the null tests' }).click()
    await heading(page, 'Review the null tests').waitFor()
    await checkBack('Choose the response cut', true)
    await shot('02-sibling')
    await selected(page).getByRole('button', { name: 'Constitution', exact: true }).click()
    await selected(page).getByRole('link', { name: 'Open validation', exact: true }).click()
    await selected(page).frameLocator('iframe').getByRole('heading', { name: 'Independent patches agree' }).waitFor()
    await checkBack('Review the null tests', false)
    await shot('03-linked-file')
    const fileHash = new URL(page.url()).hash
    await page.reload()
    await selected(page).frameLocator('iframe').getByRole('heading', { name: 'Independent patches agree' }).waitFor()
    await checkBack('Review the null tests', false)
    await shot('04-file-reloaded')
    const fileBack = phone ? page.locator('.ws-return') : selected(page).locator('.ws-document-back')
    await fileBack.click()
    await selected(page).getByRole('link', { name: 'Open validation', exact: true }).waitFor()
    await checkBack('Choose the response cut', false)
    await shot('05-chevron-to-sibling')
    await page.goBack()
    await heading(page, 'Choose the response cut').waitFor()
    await checkBack('Desk', true)
    // The page announces its selection once the channel's body and receipts settle.
    await page.waitForFunction(() => document.querySelector('.ws-reader .ws-sr-only')?.textContent === 'Chat')
    await shot('06-browser-back-to-nested')
    if (phone) {
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 60, y: 300 }] })
      for (const x of [90, 140, 210, 280]) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 300 }] })
        if (x === 90) await page.locator('.ws-stage.ws-swiping').waitFor()
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await cdp.detach()
    } else await page.keyboard.press('Escape')
    await page.locator('.ws-reader.ws-dormant').waitFor()
    assert.equal(new URL(page.url()).hash, '#/desk')
    await shot(phone ? '07-swipe-to-desk' : '07-escape-to-desk')

    // Strip entry metadata to exercise a genuinely unvisited address.
    await page.goto(url + fileHash)
    await page.evaluate(() => history.replaceState(null, ''))
    await page.reload()
    await selected(page).frameLocator('iframe').getByRole('heading', { name: 'Independent patches agree' }).waitFor()
    const deepBack = await checkBack('Board', false)
    await shot('08-deep-link')
    await deepBack.click()
    await page.locator('.ws-reader.ws-dormant').waitFor()
    assert.equal(new URL(page.url()).hash, '#/board')
    await shot('09-deep-link-to-board')
  }, viewport, 'false', 'reduce', phone)
}
