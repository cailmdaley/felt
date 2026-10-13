/** Build with npm run harness:board; run with CHROME_PATH set on Linux.
 * Fictional fixtures only. Optional HARNESS_SCREENSHOT captures the reader. */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(pathToFileURL(resolve('harness-board-dist/index.html')).href)
  await page.locator('.kbn-card').filter({ hasText: 'codex app seat' }).click()
  const composer = page.locator('.ws-page .kbn-ctl-compose').filter({ visible: true })
  await composer.getByRole('button', { name: 'Send ↵', exact: true }).waitFor()
  const field = composer.getByRole('textbox', { name: 'Message to the agent', exact: true })
  // Observe the real UI's request, not a click on a testing-only helper.
  await page.evaluate(() => {
    window.__conversationWrites = []
    const fetch = window.fetch
    window.fetch = (input, init) => {
      if (String(input).endsWith('/api/v1/dispatch') && init?.method === 'POST') {
        window.__conversationWrites.push(JSON.parse(init.body))
      }
      return fetch(input, init)
    }
  })
  await field.fill('Keep the current conversation and check the next run.')
  if (process.env.HARNESS_SCREENSHOT) await page.screenshot({ path: process.env.HARNESS_SCREENSHOT })
  await field.press('Enter')
  await page.waitForFunction(() => window.__conversationWrites.length === 1)
  assert.equal(await page.evaluate(() => window.__conversationWrites[0].resume_mode), 'previous')
  await page.waitForFunction(() => document.querySelector('.ws-page textarea.kbn-detail-directive')?.value === '')
  assert.equal(await page.evaluate(() => document.body.dataset.harnessTerminalSession), undefined)
  assert.ok(await field.isVisible(), 'a reply stays in the board reader')
  // Explicitly starting over retains the live-worker cut confirmation.
  await field.fill('Start a separate conversation.')
  page.once('dialog', dialog => dialog.dismiss())
  await field.press('Alt+Enter')
  assert.equal(await page.evaluate(() => window.__conversationWrites.length), 1)
  assert.equal(await field.inputValue(), 'Start a separate conversation.')
  page.once('dialog', dialog => dialog.accept())
  await field.press('Alt+Enter')
  await page.waitForFunction(() => window.__conversationWrites.length === 2)
  assert.equal(await page.evaluate(() => window.__conversationWrites[1].resume_mode), 'fresh')
  // A dormant CLI conversation can restart its backend without sending the
  // reader to a terminal. The transport is mocked; this proves the UI policy.
  await page.goto(pathToFileURL(resolve('harness-board-dist/index.html')).href)
  await page.locator('.kbn-card').filter({ hasText: 'Daily arXiv digest' }).click()
  const dormant = page.locator('.ws-page .kbn-ctl-compose').filter({ visible: true })
  await dormant.getByRole('button', { name: 'Continue ↵', exact: true }).waitFor()
  await page.evaluate(() => {
    window.__conversationWrites = []
    const fetch = window.fetch
    window.fetch = (input, init) => {
      if (String(input).endsWith('/api/v1/dispatch') && init?.method === 'POST') {
        window.__conversationWrites.push(JSON.parse(init.body))
        return Promise.resolve(new Response(JSON.stringify({ tmux_session: 'fictional-restarted-worker' }), { status: 200 }))
      }
      return fetch(input, init)
    }
  })
  const reply = dormant.getByRole('textbox', { name: 'Message to the agent', exact: true })
  await reply.fill('Continue with the same conversation; check the next paper.')
  if (process.env.HARNESS_SCREENSHOT) await page.screenshot({ path: process.env.HARNESS_SCREENSHOT.replace(/\.png$/, '-dormant.png') })
  await reply.press('Enter')
  await page.waitForFunction(() => window.__conversationWrites.length === 1)
  assert.equal(await page.evaluate(() => window.__conversationWrites[0].resume_mode), 'previous')
  await page.waitForFunction(() => document.querySelector('.ws-page textarea.kbn-detail-directive')?.value === '')
  assert.equal(await page.evaluate(() => document.body.dataset.harnessTerminalSession), undefined)
  assert.ok(await reply.isVisible())
  assert.deepEqual(errors, [])
  console.log('Conversation send: live and dormant replies stay in reader; explicit fresh start confirms the cut.')
} finally {
  await browser.close()
}
