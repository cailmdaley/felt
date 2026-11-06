// Browser-only voice layout: a long target must not crowd the composer and a
// growing monologue shows its newest words without moving the composer.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getBrowser } from './browser.mjs'

const browser = await getBrowser({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--allow-file-access-from-files'] })
try {
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme })
    const page = await context.newPage()
    await page.goto(`${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=music`)
    await page.locator('.kbn-desk .kbn-card').filter({ hasText: 'Music' }).first().click()
    const selected = page.locator('.ws-page.ws-selected')
    await selected.locator('textarea').waitFor()
    await page.evaluate(() => {
      const voice = window.__harness.modal.voice
      voice.dispose()
      const card = voice.card
      voice.status = { available: true, enabled: true, muted: false, state: 'listening', target: { fiber_id: 'other', origin: 'other', name: 'An exceptionally long constitution name that must not crowd the send button' }, pending: null, last: null, error: null }
      voice.notify()
      window.__voiceCard = card
    })
    const chip = selected.locator('.voice-chip')
    const meeting = selected.getByRole('button', { name: 'Meeting', exact: true })
    const send = selected.getByRole('button', { name: 'Start ↵', exact: true })
    const geometry = await page.evaluate(() => {
      const el = document.querySelector('.ws-page.ws-selected .voice-chip')
      return { width: el.getBoundingClientRect().width, scroll: el.scrollWidth, client: el.clientWidth }
    })
    assert.ok(geometry.scroll > geometry.client, 'long name is ellipsized')
    assert.ok(await meeting.isVisible(), 'Meeting remains visible')
    assert.ok(await send.isVisible(), 'send remains visible')
    const before = await selected.locator('.kbn-ctl-composer').boundingBox()
    await page.evaluate(() => {
      const voice = window.__harness.modal.voice
      const card = window.__voiceCard
      voice.status = { ...voice.status, target: { fiber_id: card.uid ?? card.id, origin: card.originId, name: card.name }, pending: { fiber_id: card.uid ?? card.id, words: 120, text: 'older words '.repeat(120) + 'THE NEWEST WORDS' } }
      voice.notify()
    })
    const pending = selected.locator('.voice-pending')
    assert.ok(await pending.evaluate(el => el.scrollHeight > el.clientHeight && Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 2), 'pending scrolls to newest words')
    const after = await selected.locator('.kbn-ctl-composer').boundingBox()
    assert.ok(Math.abs(after.y - before.y) < 1, 'pending speech does not move the composer')
    await page.screenshot({ path: `/tmp/voice-${scheme}-review.png` })
    await chip.click()
    assert.ok(await page.getByRole('menuitem', { name: 'Mute', exact: true }).isVisible())
    await context.close()
  }
  console.log('voice layout: ok')
} finally { await browser.close() }
