import { familyTree, openThread, pageBack, threadRow } from './familyNav.mjs'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=nav-back`
const selected = page => page.locator('.ws-page.ws-selected')
/** The band names, in its tooltip, the constitution it speaks to. */
const named = (page, name) => page.waitForFunction(name => document.querySelector('.ws-stage-band .ws-band-title')?.title === name, name)

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
      // The way back stands at the top: the phone's top bar, or the page's label bar.
      const control = phone ? page.locator('.ws-return') : selected(page).locator('.ws-document-back')
      assert.equal(await control.getAttribute('aria-label'), `Back to ${label}`)
      assert.equal(await control.getAttribute('title'), `Back to ${label}`)
      assert.ok(await control.isVisible())
      assert.equal(await page.locator('.ws-return:visible, .ws-page.ws-selected .ws-document-back:visible').count(), 1, 'one way back')
      assert.equal(await page.locator('.ws-stage-band .ws-band-back, .ws-stage-band .ws-band-leave').count(), 0, 'the console draws no way back')
      if (phone) {
        assert.equal(await control.locator('.ws-back-label').textContent(), label)
        assert.ok(await control.locator('.ws-back-label').isVisible())
        const scroll = selected(page).locator('.ws-family-scroll')
        if (await scroll.count()) await scroll.evaluate(el => el.scrollTo(0, 0))
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
      }
      return control
    }
    await page.goto(url + '#/desk')
    // A thread under its family's root opens its own view, whose way back is the Desk.
    // The thread asks, so its family's Desk card carries it as a waiting line.
    const name = page.locator('.kbn-desk .kbn-family-wait[data-fiber-id="research/workspace/calibration-report/analysis/checks/question"]').locator('.kbn-family-want')
    const questionSlug = 'question'
    const land = async () => {
      const nameBox = await name.boundingBox()
      await name.click({ position: { x: nameBox.width - 6, y: nameBox.height / 2 } })
      await named(page, 'Choose the response cut')
    }
    await land()
    await checkBack('Desk')
    await shot('01-nested-from-desk')
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
    await shot(phone ? '02-swipe-to-desk' : '02-escape-to-desk')
    await land()
    // The family's root's view, from its head above; then another of its threads, one level down.
    const parent = selected(page).locator('.ov-ancestor').first()
    const parentName = await parent.getAttribute('title'), parentSlug = await parent.locator('.ov-slug').textContent()
    await parent.click()
    await named(page, parentName)
    // The way back names a fiber by its slug.
    await checkBack(questionSlug)
    await openThread(page, threadRow(page, await familyTree(page), 'Review the null tests'), 'Review the null tests')
    await checkBack(parentSlug)
    await shot('03-sibling')
    // Its constitution, from its head, and a file linked there.
    await selected(page).locator('.ov-head [data-part="constitution"]').click()
    await selected(page).getByRole('link', { name: 'Open validation', exact: true }).click()
    await selected(page).frameLocator('iframe').getByRole('heading', { name: 'Independent patches agree' }).waitFor()
    await checkBack('Constitution')
    await shot('04-linked-file')
    const fileHash = new URL(page.url()).hash
    await pageBack(page)
    await selected(page).getByRole('link', { name: 'Open validation', exact: true }).click()
    await page.reload()
    await selected(page).frameLocator('iframe').getByRole('heading', { name: 'Independent patches agree' }).waitFor()
    await checkBack('Constitution')
    await shot('05-file-reloaded')
    await page.goBack()
    await selected(page).getByRole('link', { name: 'Open validation', exact: true }).waitFor()

    // Strip entry metadata to exercise a genuinely unvisited address.
    await page.goto(url + fileHash)
    await page.evaluate(() => history.replaceState(null, ''))
    await page.reload()
    await selected(page).frameLocator('iframe').getByRole('heading', { name: 'Independent patches agree' }).waitFor()
    const deepBack = await checkBack('Channels')
    await shot('06-deep-link')
    await deepBack.click()
    await page.locator('.ws-reader.ws-dormant').waitFor()
    assert.equal(new URL(page.url()).hash, '#/channels')
    await shot('07-deep-link-to-channels')
  }, viewport, 'reduce', phone)
}
