import { familyTree, openThread, pageBack } from './familyNav.mjs'
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
  ]) test(`Back from the Desk (${device}): nested landing, orchestrator, sibling, file, reload and deep link each go back in one step`, async page => {
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
    const name = page.locator('.kbn-desk .kbn-family-line[data-fiber-id="research/workspace/calibration-report/analysis/checks/question"]').locator('.thread-row-doing')
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
    await parent.click()
    await named(page, 'Calibrate the shear response')
    // However deep the reader goes, its way back names the view it was opened from.
    await checkBack('Desk')
    const tree = await familyTree(page)
    await openThread(page, tree.locator('.ov-thread[data-fiber="thread-review"]'), 'Review the null tests')
    await checkBack('Desk')
    await shot('03-sibling')
    // Its constitution, from its head, and a file linked there.
    await selected(page).locator('.ov-head [data-part="constitution"]').click()
    await selected(page).getByRole('link', { name: 'Open validation', exact: true }).click()
    await selected(page).frameLocator('iframe').getByRole('heading', { name: 'Independent patches agree' }).waitFor()
    await checkBack('Desk')
    await shot('04-linked-file')
    const fileHash = new URL(page.url()).hash
    // One press, from four pages deep.
    await pageBack(page)
    await page.locator('.ws-reader.ws-dormant').waitFor()
    assert.equal(new URL(page.url()).hash, '#/desk')
    // Forward reopens the file, and a reload keeps the Desk below it.
    await page.goForward()
    await selected(page).frameLocator('iframe').getByRole('heading', { name: 'Independent patches agree' }).waitFor()
    await page.reload()
    await selected(page).frameLocator('iframe').getByRole('heading', { name: 'Independent patches agree' }).waitFor()
    await checkBack('Desk')
    await shot('05-file-reloaded')
    await page.goBack()
    await page.locator('.ws-reader.ws-dormant').waitFor()
    assert.equal(new URL(page.url()).hash, '#/desk')

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

const channelsUrl = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=channels#/channels`
/** The unions channel: chosen from the rail, or already shown where a phone reopens the channel it last showed. */
async function toUnions(page) {
  const pick = page.locator('.kbn-ch-pick', { hasText: 'unions' }).first()
  await pick.waitFor({ state: 'attached' })
  if (await pick.isVisible()) await pick.click()
}
const streamScroll = page => page.locator('.kbn-ch .kbn-ch-stream').evaluate(el => {
  for (let node = el; node; node = node.parentElement) if (node.scrollHeight > node.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return Math.round(node.scrollTop)
  return Math.round(document.scrollingElement.scrollTop)
})

/**
 * Channels: a post opens its thread, then the orchestrator and the thread
 * again, back and forth, then a file; each way back (the reader's ‹,
 * Escape, the browser's Back, the Channels tab) lands on the channel in one
 * press, scrolled where it was, the post in focus. The swipe is not a way
 * back here: it brings the rail (`channels.mjs`, `railGesture.mjs`).
 * An unfolded file sent to full screen comes back unfolded with the keys.
 */
export function registerChannelsBackJourneys(test) {
  for (const [device, viewport, phone] of [
    ['phone', { width: 390, height: 844 }, true],
    ['desktop', { width: 1440, height: 900 }, false],
  ]) test(`Back from Channels (${device}): every way back is one press to the channel, where it was`, async page => {
    const ways = phone ? ['reader', 'browser'] : ['reader', 'escape', 'browser', 'tab']
    for (const way of ways) {
      await page.goto(channelsUrl)
      await toUnions(page)
      const posts = page.locator('.kbn-ch .kbn-ch-item .kbn-ch-who')
      await posts.first().waitFor()
      const post = posts.nth(3)
      await post.scrollIntoViewIfNeeded()
      const item = await post.getAttribute('data-item')
      const scrolled = await streamScroll(page)
      const below = await page.evaluate(() => navigation.currentEntry.index)
      await post.click()
      await page.locator('.ws-reader:not(.ws-dormant)').waitFor()
      for (let i = 0; i < 2; i++) {
        await page.keyboard.press('b')
        await page.waitForFunction(() => /unions@/.test(decodeURIComponent(location.hash)) && !/\/unions\/[^@]+@/.test(decodeURIComponent(location.hash)))
        await selected(page).locator('.thread-row').nth(2).click()
        await page.waitForFunction(() => !/unions@/.test(decodeURIComponent(location.hash)) || /\/unions\/[^@]+@/.test(decodeURIComponent(location.hash)))
      }
      await selected(page).locator('.ws-doc-button').nth(1).click()
      const history = await page.evaluate(() => ({ index: navigation.currentEntry.index, length: navigation.entries().length }))
      assert.deepEqual(history, { index: below + 1, length: below + 2 }, `${way}: the reader holds one entry above Channels, however far it went`)
      if (way === 'reader') await (phone ? page.locator('.ws-return') : selected(page).locator('.ws-document-back')).click()
      else if (way === 'escape') { await page.locator('.ws-reader').click({ position: { x: 4, y: 200 } }).catch(() => {}); await page.keyboard.press('Escape') }
      else if (way === 'browser') await page.goBack()
      else if (way === 'tab') await page.locator('button[data-view="channels"]').first().click()
      await page.locator('.ws-reader.ws-dormant').waitFor()
      assert.equal(new URL(page.url()).hash, '#/channels', `${way}: one press reaches the channel`)
      assert.equal(await page.locator('.kbn-ch-pick[aria-current="true"], .kbn-ch-pick.kbn-ch-pick-on').first().textContent().catch(() => 'unions').then(t => t.includes('unions')), true)
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.item), item, `${way}: the post opened from has the focus`)
      assert.equal(await streamScroll(page), scrolled, `${way}: the stream is where it was left`)
    }

    // A post's file opens in the reader; one back returns to the post, in focus.
    await page.goto(channelsUrl)
    await toUnions(page)
    const several = page.locator('.kbn-ch .kbn-ch-item:has(.kbn-ch-previews .uf[data-several])').first()
    const from = await several.locator('[data-item]').first().getAttribute('data-item')
    await several.locator('.uf-card').first().click()
    await page.locator('.ws-reader:not(.ws-dormant)').waitFor()
    await (phone ? page.locator('.ws-return') : selected(page).locator('.ws-document-back')).click()
    await page.locator('.ws-reader.ws-dormant').waitFor()
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.item), from, 'the post the file was opened from has the focus')
  }, viewport, 'reduce', phone)
}

/**
 * A constitution's view: a sent file unfolded there and sent full screen,
 * stepped through further than the reader keeps pages for, comes back to the
 * view still unfolded, on the file last read, with its bar and its keys.
 */
export function registerViewFullScreenJourneys(test) {
  test('Full screen from a constitution\'s view: back on the view, the file last read is the one unfolded', async page => {
    await page.goto(`${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=workspace&manyFiles#/board/01KVBR1F9BWBVKF97473PV67K8@umber-workstation`)
    const view = await familyTree(page)
    const unfold = view.locator('.ov-unfold')
    await unfold.locator('.uf-card').click()
    await page.keyboard.press('ArrowRight')
    await unfold.locator('.uf-count', { hasText: '2 / ' }).waitFor()
    await unfold.locator('.uf-full').click()
    await page.locator('.ws-page.ws-selected:not([data-key^="family:"])').waitFor()
    for (let n = 0; n < 12; n++) await page.keyboard.press('ArrowRight')
    await page.evaluate(() => { document.activeElement?.blur() })
    await page.keyboard.press('l')
    await view.locator('.ov-head').waitFor()
    assert.equal(await unfold.getAttribute('data-unfolded'), '', 'still unfolded')
    assert.ok(await unfold.locator('.uf-bar').isVisible(), 'its bar stands above it')
    assert.match(await unfold.locator('.uf-count').textContent(), /^14 \/ /, 'on the file last read full screen')
    await page.keyboard.press('ArrowRight')
    await unfold.locator('.uf-count', { hasText: '15 / ' }).waitFor()
  }, { width: 1440, height: 900 }, 'reduce', false)
}

/** `t` on a post in Channels opens its worker's tapestry in the reader; a worker with none moves nothing. */
export function registerPostTapestryJourneys(test) {
  test('t on a post in Channels opens its tapestry in the reader', async page => {
    await page.goto(channelsUrl)
    await page.locator('.kbn-ch-pick', { hasText: 'cmbx' }).first().click()
    const post = fiber => page.locator(`.kbn-ch-item[data-fiber="${fiber}"]`).last()
    await post('cmbx/foregrounds').locator('.kbn-ch-who').focus()
    await page.keyboard.press('t')
    await page.waitForTimeout(200)
    assert.equal(await page.locator('.ws-reader:not(.ws-dormant)').count(), 0, 'no tapestry, nothing opens')
    await post('cmbx/kappa-tsz').locator('.kbn-ch-who').focus()
    await page.keyboard.press('t')
    await page.locator('.ws-reader:not(.ws-dormant)').waitFor()
    await page.waitForFunction(() => /tapestry\.html/.test(decodeURIComponent(location.hash)))
  }, { width: 1280, height: 860 }, 'reduce', false)
}
