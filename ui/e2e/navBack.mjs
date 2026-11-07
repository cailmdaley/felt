import { familyTree } from './familyNav.mjs'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=nav-back`
const selected = page => page.locator('.ws-page.ws-selected')
const named = (page, name) => page.waitForFunction(name => document.querySelector('.ws-stage-band .ws-band-title')?.textContent === name, name)

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
    const checkBack = async label => {
      const control = phone ? page.locator('.ws-return') : selected(page).locator('.ws-document-back')
      assert.equal(await control.getAttribute('aria-label'), `Back to ${label}`)
      assert.equal(await control.getAttribute('title'), `Back to ${label}`)
      assert.ok(await control.isVisible())
      assert.equal(await control.locator('.ws-back-label').textContent(), label)
      assert.ok(await control.locator('.ws-back-label').isVisible())
      if (!phone) assert.equal(await control.evaluate(el => getComputedStyle(el).textIndent), '0px')
      if (phone) {
        await control.hover()
        assert.equal(await control.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', 'Touch back controls have no sticky hover background')
        await page.mouse.move(viewport.width - 1, viewport.height - 1)

        const bounds = await control.evaluate(button => {
          const head = button.closest('.ws-navbar')
          const box = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height, center: r.top + r.height / 2 } }
          const title = head.querySelector('.ws-channel-title')
          const stroke = getComputedStyle(button, '::before')
          return {
            back: box(button), title: box(title), label: box(button.querySelector('.ws-back-label')),
            stroke: { width: stroke.width, height: stroke.height, left: stroke.borderLeftWidth, bottom: stroke.borderBottomWidth, content: stroke.content },
          }
        })
        assert.ok(bounds.back.right <= bounds.title.left && bounds.title.width > 80, JSON.stringify(bounds))
        assert.ok(bounds.back.height >= 44 && bounds.back.width <= viewport.width / 3, JSON.stringify(bounds))
        assert.ok(Math.abs(bounds.back.center - bounds.title.center) < 1, `Back and title share a centerline: ${JSON.stringify(bounds)}`)
        assert.ok(bounds.label.height < 25, `The destination stays on one line: ${JSON.stringify(bounds)}`)
        assert.deepEqual([bounds.stroke.width, bounds.stroke.height, bounds.stroke.content], ['11px', '11px', '""'])
        assert.ok(parseFloat(bounds.stroke.left) >= 1 && bounds.stroke.left === bounds.stroke.bottom, JSON.stringify(bounds.stroke))
        if (label === 'Choose the response cut') assert.ok(bounds.back.width >= 120, `Long destinations get a third of the bar: ${JSON.stringify(bounds)}`)
      }
      return control
    }
    await page.goto(url + '#/desk')
    // The card's own name opens its lead; the family's other askers sit on rows beneath it.
    const name = page.locator('.kbn-desk .kbn-card[data-fiber-id="research/workspace/calibration-report/analysis/checks/question"]').locator('.kbn-card-name')
    const nameBox = await name.boundingBox()
    await name.click({ position: { x: nameBox.width - 6, y: nameBox.height / 2 } })
    await named(page, 'Choose the response cut')
    await checkBack('Desk')
    await shot('01-nested-from-desk')
    const rows = (await familyTree(page)).locator('.kbn-thread-row')
    await rows.filter({ hasText: 'Review the null tests' }).click()
    await named(page, 'Review the null tests')
    await checkBack('Choose the response cut')
    await shot('02-sibling')
    await selected(page).getByRole('link', { name: 'Open validation', exact: true }).click()
    await selected(page).frameLocator('iframe').getByRole('heading', { name: 'Independent patches agree' }).waitFor()
    await checkBack('Constitution')
    await shot('03-linked-file')
    const fileHash = new URL(page.url()).hash
    await page.reload()
    await selected(page).frameLocator('iframe').getByRole('heading', { name: 'Independent patches agree' }).waitFor()
    await checkBack('Constitution')
    await shot('04-file-reloaded')
    const fileBack = phone ? page.locator('.ws-return') : selected(page).locator('.ws-document-back')
    await fileBack.click()
    await selected(page).getByRole('link', { name: 'Open validation', exact: true }).waitFor()
    await checkBack('Choose the response cut')
    await shot('05-chevron-to-sibling')
    await page.goBack()
    await named(page, 'Choose the response cut')
    await checkBack('Constitution')
    await page.goBack()
    await checkBack('Desk')
    // The page announces its selection once the channel's body and receipts settle.
    await page.waitForFunction(() => document.querySelector('.ws-reader .ws-sr-only')?.textContent === 'Constitution')
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
    const deepBack = await checkBack('Board')
    await shot('08-deep-link')
    await deepBack.click()
    await page.locator('.ws-reader.ws-dormant').waitFor()
    assert.equal(new URL(page.url()).hash, '#/board')
    await shot('09-deep-link-to-board')
  }, viewport, 'reduce', phone)
}
