import assert from 'node:assert/strict'
import { pageBack, showFile } from './familyNav.mjs'

/** Runs with the workspace journeys, against the same owner-routed file harness. */
export function registerChangeJourneys(test) {
  const open = async page => {
    page.setDefaultTimeout(30_000)
    await page.goto(page.url().replace('example=workspace', 'example=change'))
    await page.locator(`.kbn-desk .kbn-card:not(.kbn-card-header):has(.kbn-card-name[title*="Calibrate the shear response"])`).click()
    await page.locator('.ws-stage-band .ws-dock').waitFor()
    await showFile(page, '/family.change.json')
    await page.locator('.ws-selected .change-reader').waitFor()
    await page.locator('.ws-selected .change-map').waitFor()
    await page.locator('.ws-selected .change-chapter-link').first().click()
    await page.locator('.ws-selected diffs-container [data-line-index]').first().waitFor()
  }
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) test(`A change opens, persists a review, and sends one owner-routed message (${viewport.width}px)`, async page => {
    await open(page)
    const reader = page.locator('.ws-selected .change-reader')
    const neutral = await reader.locator('.change-file[data-status="added"]').first().evaluate(card => {
      const style = getComputedStyle(card)
      return [style.getPropertyValue('--diffs-bg-addition-override').trim(), style.getPropertyValue('--ws-paper').trim()]
    })
    assert.equal(neutral[0], neutral[1], 'added files read on paper, with change color confined to the gutter')
    await reader.getByRole('button', { name: 'Mark viewed', exact: true }).first().click()
    assert.equal(await reader.locator('.change-file').first().getAttribute('open'), null)
    await reader.locator('.change-file-head').first().click()
    const note = reader.getByRole('textbox', { name: 'Overall review note' })
    await note.fill('Check the root-relative count before landing.')
    if (viewport.width <= 700) {
      assert.equal(await reader.locator('.change-file-head .change-role').first().isVisible(), true, 'file roles stay visible on phones too')
      assert.equal(await page.locator('.ws-reader').evaluate(node => node.classList.contains('ws-topbar-hidden')), false, 'review navigation stays visible while virtual windows resize')
      const [icon, tabs] = await Promise.all([page.locator('.ws-navbar .ws-files-toggle').boundingBox(), reader.locator('.change-contents').boundingBox()])
      assert.ok(icon && tabs && icon.y + icon.height <= tabs.y + 1, 'the contents control belongs above the chapter tabs, not on top of them')
    }
    await reader.locator('.change-chapter-link').filter({ hasText: 'Keep the root in sight' }).click()
    const number = reader.locator('.change-file').first().locator('diffs-container [data-column-number]').first()
    await number.click()
    const comment = reader.locator('.change-file').first().getByRole('textbox', { name: /^Comment on/ })
    await comment.fill('Does the root exclude itself here?')
    assert.equal(await reader.locator('.change-draft-comments textarea').inputValue(), 'Does the root exclude itself here?')
    await page.reload()
    await page.locator('.ws-selected .change-reader').waitFor()
    assert.equal(await page.getByRole('textbox', { name: 'Overall review note' }).inputValue(), 'Check the root-relative count before landing.')
    assert(await page.getByRole('button', { name: '✓ Viewed', exact: true }).count() > 0)
    await page.evaluate(() => {
      const fetch = window.fetch
      window.fetch = (input, init) => String(input).endsWith('/api/v1/dispatch') ? Promise.resolve(Response.json({ error: 'Worker unavailable' }, { status: 503 })) : fetch(input, init)
    })
    await page.getByRole('button', { name: 'Send review', exact: true }).click()
    await page.getByRole('status').filter({ hasText: 'Worker unavailable' }).waitFor()
    await page.reload()
    await page.getByRole('textbox', { name: 'Overall review note' }).waitFor()
    assert.equal(await page.locator('.ws-selected .change-draft-comments textarea').inputValue(), 'Does the root exclude itself here?')
    await page.getByRole('button', { name: 'Send review', exact: true }).click()
    await page.getByRole('status').filter({ hasText: 'Review sent to the worker' }).waitFor()
    const sends = await page.evaluate(() => window.__harness.requests.filter(request => request.method === 'POST' && request.url.endsWith('/api/v1/dispatch')).map(request => JSON.parse(request.body)))
    assert.equal(sends.length, 1)
    assert.equal(sends[0].origin, 'umber-workstation')
    assert.equal(sends[0].fiber_id, 'research/workspace/calibration-report')
    assert.equal(sends[0].resume_mode, 'previous')
    assert.match(sends[0].user_message, /Head: [a-f0-9]{40}/)
    assert.match(sends[0].user_message, /ui\/src\/board\/threads.ts:\d+\n/)
    assert.equal(sends[0].force, true)
    assert.equal(sends[0].existing_only, true)
    assert.match(sends[0].user_message, /Does the root exclude itself/)
    assert.equal(await page.getByRole('textbox', { name: 'Overall review note' }).inputValue(), '')
  }, viewport)
  test('A change without a story retains every file, and a large change mounts bounded diff windows', async page => {
    await open(page)
    const family = page.url()
    await page.goto(family.replace('family.change.json', 'plain.change.json'))
    await page.locator('.ws-selected .change-reader h1').waitFor()
    assert.match(await page.locator('.ws-selected .change-reader').innerText(), /No authored story/)
    assert.equal(await page.locator('.ws-selected .change-file').count(), 5)
    await page.goto(family.replace('family.change.json', 'large.change.json'))
    await page.locator('.ws-selected .change-reader h1').filter({ hasText: '5,000-line' }).waitFor()
    assert.equal(await page.locator('.ws-selected .change-diff-window').count(), 0)
    await page.locator('.ws-selected .change-file-head').click()
    await page.locator('.ws-selected diffs-container').first().waitFor()
    assert.equal(await page.locator('.ws-selected .change-diff-window').count(), 84)
    assert.ok(await page.locator('.ws-selected diffs-container').count() < 10)
  })
  test('A tapestry relative link opens by keyboard and Back returns to the tapestry', async page => {
    page.setDefaultTimeout(30_000)
    await page.addInitScript(() => {
      window.addEventListener('message', event => {
        if (event.source === window.parent && event.data?.protocol === 'shuttle-document' && event.data?.type === 'active') window.__changeBridgeActive = event.data.payload.active
      })
    })
    await page.goto(page.url().replace('example=workspace', 'example=change'))
    await page.locator(`.kbn-desk .kbn-card:not(.kbn-card-header):has(.kbn-card-name[title*="Calibrate the shear response"])`).click()
    const family = page.locator('.ws-selected'), route = new URL(page.url()).hash
    // A constitution without threads opens on its tapestry already unfolded.
    const lead = family.locator('.fp-row[aria-selected="true"] .fp-lead')
    await lead.waitFor()
    if (await lead.getAttribute('aria-pressed') !== 'true') await lead.click()
    assert.equal(new URL(page.url()).hash, route)
    await family.locator('.fp-row[aria-selected="true"] .fp-doc iframe').waitFor()
    const link = page.frameLocator('.ws-selected iframe').getByRole('link', { name: 'Read the change →' })
    await link.waitFor()
    await page.locator('.ws-selected .kbn-fileview-loading').waitFor({ state: 'detached' })
    const frame = await (await page.locator('.ws-selected iframe').elementHandle()).contentFrame()
    await frame.waitForFunction(() => window.__changeBridgeActive === true)
    const popups = []; page.on('popup', popup => popups.push(popup))
    await link.press('Enter')
    await page.locator('.ws-selected .change-reader').waitFor()
    assert.equal(popups.length, 0, 'relative change links stay in the workspace after the report bridge is ready')
    await pageBack(page)
    await page.frameLocator('.ws-selected .fp-doc iframe').getByRole('link', { name: 'Read the change →' }).waitFor()
    assert.equal(new URL(page.url()).hash, route)
  })
}
