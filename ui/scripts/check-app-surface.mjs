/** Real Capture form and card-drawer browser check against the offline board
 * harness. Run `npm run harness:board` then `node scripts/check-app-surface.mjs`.
 * CHROME_PATH selects an installed Chromium; SCREENSHOT_DIR saves both sizes.
 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(pathToFileURL(resolve('harness-board-dist/index.html')).href)
  await page.getByRole('button', { name: 'New idea — speak it into a card', exact: true }).click()
  const agent = page.locator('select').filter({ has: page.locator('option[value="codex-luna"]') })
  await agent.selectOption('codex-luna')
  const surface = page.locator('select').filter({ has: page.locator('option[value="app"]') })
  assert.equal(await surface.inputValue(), 'app', 'new Codex captures default to app')
  for (const [name, viewport] of [
    ['desktop', { width: 1200, height: 900 }],
    ['phone', { width: 390, height: 844 }],
  ]) {
    await page.setViewportSize(viewport)
    await page.waitForTimeout(200)
    const box = await surface.boundingBox()
    assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width, `${name}: surface selector fits`)
    const submit = await page.getByRole('button', { name: 'Spawn', exact: true }).boundingBox()
    assert.ok(submit && submit.y >= 0 && submit.y + submit.height <= viewport.height, `${name}: submit remains visible`)
    if (process.env.SCREENSHOT_DIR) {
      await mkdir(process.env.SCREENSHOT_DIR, { recursive: true })
      await page.screenshot({ path: resolve(process.env.SCREENSHOT_DIR, `capture-${name}.png`) })
    }
  }
  await surface.selectOption('cli')
  assert.equal(await surface.inputValue(), 'cli')
  await agent.selectOption('claude-opus')
  assert.equal(await page.getByRole('combobox', { name: 'Session', exact: true }).count(), 0, 'a Claude capture has no session choice')

  await page.goto(pathToFileURL(resolve('harness-board-dist/index.html')).href)
  await page.getByText('App conversation continuity', { exact: true }).click()
  const drawer = page.locator('.kbn-detail-controls-toggle')
  const verdicts = await page.locator('.kbn-ctl-foot .kbn-ctl-btn').allInnerTexts()
  assert.deepEqual(verdicts, ['Discard', 'Temper'], 'the drawer offers both verdicts, Temper under Resume')
  const stripWho = () => page.locator('.kbn-ctl-who > span').allInnerTexts()
  assert.equal((await stripWho())[0], 'codex-luna', 'the folded strip leads with the agent')
  await drawer.click()
  const detailSurface = page.getByRole('radiogroup', { name: 'Session', exact: true })
  const appChoice = detailSurface.getByRole('radio', { name: 'App', exact: true })
  const terminalChoice = detailSurface.getByRole('radio', { name: 'Terminal', exact: true })
  await detailSurface.scrollIntoViewIfNeeded()
  assert.equal(await appChoice.getAttribute('aria-checked'), 'true', 'existing app conversation retains its mode')
  assert.ok(await detailSurface.isVisible(), 'existing task visibly identifies its session type')
  const detailBox = await detailSurface.boundingBox()
  assert.ok(detailBox && detailBox.x >= 0 && detailBox.x + detailBox.width <= 390, 'phone: detail session choice fits')
  if (process.env.SCREENSHOT_DIR) {
    await page.screenshot({ path: resolve(process.env.SCREENSHOT_DIR, 'detail-phone.png') })
  }
  // Sessions: newest first, each with the one link its transcript supports.
  const sessionRows = page.locator('.kbn-ctl-session')
  await sessionRows.first().waitFor()
  assert.equal(await sessionRows.count(), 6, 'the folded history shows six sessions')
  const liveRow = sessionRows.nth(0)
  assert.equal(await liveRow.getAttribute('data-session'), '01a0be38-6c36-7cd1-aec9-53a680d1f693', 'newest first')
  assert.equal(await liveRow.locator('.kbn-ctl-session-live').count(), 1, 'the running session is marked live')
  assert.equal(
    await liveRow.locator('a.kbn-ctl-session-app').getAttribute('href'),
    'codex://threads/01a0be38-6c36-7cd1-aec9-53a680d1f693',
    'a Codex thread on the board host opens in the desktop app',
  )
  const claimRow = page.locator('.kbn-ctl-session[data-session="f466597a-56d0-4047-8585-2159281ca18b"]')
  assert.deepEqual(
    await claimRow.locator('.kbn-ctl-session-agent, .kbn-ctl-session-kind').allInnerTexts(),
    ['claude-fable', 'claim'],
    'agent, and the kind when it is not a plain dispatch',
  )
  const claimLink = claimRow.locator('a.kbn-ctl-session-web')
  assert.equal(await claimLink.getAttribute('href'), 'https://claude.ai/code/session_01F466597A')
  assert.equal(await claimLink.getAttribute('target'), '_blank', 'a claude.ai page opens in a new tab')
  const unbridged = page.locator('.kbn-ctl-session[data-session="b69296a4-1023-4231-b372-270d7b3c4a9b"]')
  assert.equal(await unbridged.locator('a').count(), 0, 'an unbridged session is never linked')
  assert.equal(await unbridged.locator('button.kbn-ctl-session-copy').innerText(), 'b69296a4')
  await page.locator('.kbn-ctl-session-more').click()
  await page.waitForFunction(() => document.querySelectorAll('.kbn-ctl-session').length === 8)
  const foreign = page.locator('.kbn-ctl-session[data-session="c6239266-4ba7-4b72-9ba0-fb302c75458e"]')
  assert.equal(await foreign.locator('.kbn-ctl-session-host').innerText(), 'basalt-login-02', 'a session run elsewhere names its host')
  assert.ok((await foreign.locator('a.kbn-ctl-session-web').getAttribute('href')).startsWith('https://claude.ai/'))
  const pi = page.locator('.kbn-ctl-session[data-session="01a042f4-6b7f-7f79-9c6c-8140ffd0126c"]')
  assert.equal(await pi.locator('a').count(), 0, 'a pi session has no link to open')
  const historyBox = await page.locator('.kbn-ctl-sessions').boundingBox()
  assert.ok(historyBox && historyBox.x + historyBox.width <= 390, 'phone: the history fits')
  if (process.env.SCREENSHOT_DIR) {
    await page.locator('.kbn-ctl-history').screenshot({ path: resolve(process.env.SCREENSHOT_DIR, 'sessions-phone.png') })
  }

  // Editing a live worker's settings must never substitute for a launch gesture.
  await page.evaluate(() => {
    window.settingWrites = []
    const originalFetch = window.fetch
    window.fetch = (input, init) => {
      if (init?.method === 'POST') window.settingWrites.push({ url: String(input), body: JSON.parse(init.body) })
      return originalFetch(input, init)
    }
  })
  const dialogs = []
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept() })
  const detailAgent = page.locator('#kbn-detail-agent')
  await detailAgent.selectOption('claude-opus')
  assert.ok(!(await detailSurface.isVisible()), 'a Claude agent has no session choice to show')
  await page.locator('#kbn-detail-chrome').check()
  await detailAgent.selectOption('codex-luna')
  assert.ok(!(await page.locator('#kbn-detail-chrome').isVisible()), 'chrome is not offered to a Codex agent')
  await page.locator('#kbn-detail-effort').selectOption('high')
  // The detour through Claude left the session on Terminal.
  assert.equal(await terminalChoice.getAttribute('aria-checked'), 'true')
  await terminalChoice.click()
  await appChoice.click()
  await page.waitForTimeout(200)
  const writes = await page.evaluate(() => window.settingWrites)
  assert.equal(writes.length, 5, 're-picking the current session writes nothing; every change writes once')
  assert.ok(writes.every(write => write.url.endsWith('/api/v1/lifecycle') && write.body.action === 'set-agent'), JSON.stringify(writes))
  assert.equal(writes.at(-1).body.surface, 'app')
  assert.deepEqual(dialogs, [], 'settings do not ask to replace the live session')
  assert.deepEqual(await stripWho(), ['codex-luna', 'high'], 'the strip follows the committed settings')


  await page.goto(pathToFileURL(resolve('harness-board-dist/index.html')).href)
  await page.getByText('Run the 2D B-mode null tests', { exact: true }).click()
  await page.locator('.kbn-detail-controls-toggle').click()
  await page.evaluate(() => {
    window.settingWrites = []
    const originalFetch = window.fetch
    window.fetch = (input, init) => {
      if (init?.method === 'POST') window.settingWrites.push({ url: String(input), body: JSON.parse(init.body) })
      return originalFetch(input, init)
    }
  })
  await page.locator('#kbn-detail-agent').selectOption('claude-opus')
  await page.locator('#kbn-detail-chrome').check()
  await page.locator('#kbn-detail-agent').selectOption('codex-luna')
  await page.waitForTimeout(200)
  const terminalWrites = await page.evaluate(() => window.settingWrites)
  assert.equal(terminalWrites.length, 3)
  assert.ok(terminalWrites.every(write => write.url.endsWith('/api/v1/lifecycle') && write.body.action === 'set-agent'), JSON.stringify(terminalWrites))
  assert.deepEqual(dialogs, [], 'changing terminal model or Chrome must not trigger restart')

  // Standing is a revealed form until its cron is confirmed: the click writes
  // nothing, Enter in the cron writes the promotion once.
  await page.evaluate(() => { window.settingWrites = [] })
  const dueField = page.locator('.kbn-ctl-date')
  assert.ok(await dueField.isVisible(), 'a one-shot card shows its due field')
  await page.getByRole('radiogroup', { name: 'Kind', exact: true }).getByRole('radio', { name: 'Standing', exact: true }).click()
  assert.equal((await page.evaluate(() => window.settingWrites)).length, 0, 'choosing Standing alone writes nothing')
  const cron = page.getByRole('textbox', { name: 'Cron', exact: true })
  assert.equal(await cron.inputValue(), '0 9 * * 1-5')
  await cron.press('Enter')
  await page.waitForTimeout(200)
  const promotion = await page.evaluate(() => window.settingWrites)
  assert.equal(promotion.length, 1, JSON.stringify(promotion))
  assert.deepEqual(
    { action: promotion[0].body.action, kind: promotion[0].body.kind, schedule: promotion[0].body.schedule },
    { action: 'reshape', kind: 'standing', schedule: '0 9 * * 1-5' },
  )
  assert.ok(!(await dueField.isVisible()), 'a standing role has no due field — it runs on its cron')

  // Escape in the parent search cancels the search, not the card.
  await page.locator('.kbn-ctl-parent').click()
  await page.getByRole('combobox', { name: 'Search parent fiber', exact: true }).press('Escape')
  assert.equal(await page.locator('.kbn-detail-controls').count(), 1, 'Escape in the parent search keeps the card open')
  assert.ok(await page.locator('.kbn-ctl-parent').isVisible(), 'Escape puts the parent id back')

  // A refused kind write puts the control back on what the wire says.
  await page.evaluate(() => {
    const passthrough = window.fetch
    window.restoreFetch = () => { window.fetch = passthrough }
    window.fetch = (input, init) => {
      if (init?.method === 'POST' && JSON.parse(init.body).action === 'reshape') {
        return Promise.resolve(new Response('reshape refused', { status: 500 }))
      }
      return passthrough(input, init)
    }
  })
  const kindGroup = page.getByRole('radiogroup', { name: 'Kind', exact: true })
  await kindGroup.getByRole('radio', { name: 'Pinned', exact: true }).click()
  await page.waitForTimeout(200)
  assert.equal(await kindGroup.getByRole('radio', { name: 'Standing', exact: true }).getAttribute('aria-checked'), 'true', 'a refused reshape rolls the kind back')
  assert.ok(await page.getByText('reshape refused').isVisible(), 'the refusal is shown')
  await page.evaluate(() => window.restoreFetch())

  // Meeting asks Call or Room before it records; only the answer starts one,
  // carrying the composer's message as the note.
  await page.evaluate(() => { window.settingWrites = [] })
  const message = page.getByRole('textbox', { name: 'Message for the next worker', exact: true })
  const meeting = page.getByRole('button', { name: 'Meeting', exact: true })
  await meeting.click()
  assert.ok(await page.getByRole('menu', { name: 'Meeting kind', exact: true }).isVisible(), 'Meeting opens its kinds')
  assert.equal((await page.evaluate(() => window.settingWrites)).length, 0, 'opening Meeting starts nothing')
  await page.keyboard.press('Escape')
  assert.ok(!(await page.getByRole('menu', { name: 'Meeting kind', exact: true }).isVisible()), 'Escape closes the menu')
  assert.equal(await page.locator('.kbn-detail-controls').count(), 1, 'Escape in the menu keeps the card open')
  await message.fill('null tests review')
  await meeting.click()
  await page.getByRole('menuitem', { name: 'Room', exact: true }).click()
  await page.waitForTimeout(200)
  const joins = (await page.evaluate(() => window.settingWrites)).filter(write => write.url.endsWith('/api/v1/meeting/join'))
  assert.equal(joins.length, 1, 'choosing Room starts exactly one meeting')
  assert.deepEqual({ mode: joins[0].body.meeting.mode, note: joins[0].body.note }, { mode: 'room', note: 'null tests review' })
  assert.equal(await message.inputValue(), '', 'the note is spent once the meeting starts')
  assert.ok(await meeting.isVisible() && await meeting.isDisabled(), 'while a meeting records, Meeting stays in place, inert')
  assert.match(await meeting.getAttribute('title'), /^Recording: /)

  // Resume carries the message exactly as written.
  await page.evaluate(() => { window.settingWrites = [] })
  await message.fill('rerun the null tests')
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await page.waitForTimeout(200)
  const dispatch = (await page.evaluate(() => window.settingWrites)).find(write => write.url.endsWith('/api/v1/dispatch'))
  assert.ok(dispatch, 'Resume dispatches')
  assert.equal(dispatch.body.resume_mode, 'previous')
  assert.equal(dispatch.body.user_message, 'rerun the null tests')

  // Discard is the `tempered: false` verdict.
  await page.goto(pathToFileURL(resolve('harness-board-dist/index.html')).href)
  await page.getByText('File the conference travel reimbursement', { exact: true }).click()
  await page.locator('.kbn-detail-controls-toggle').click()
  await page.evaluate(() => {
    window.settingWrites = []
    const originalFetch = window.fetch
    window.fetch = (input, init) => {
      if (init?.method === 'POST') window.settingWrites.push({ url: String(input), body: JSON.parse(init.body) })
      return originalFetch(input, init)
    }
  })
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await page.waitForTimeout(300)
  const verdict = JSON.stringify(await page.evaluate(() => window.settingWrites))
  assert.match(verdict, /composted|"tempered":false/, `Discard writes the false verdict: ${verdict}`)

  await page.goto(pathToFileURL(resolve('harness-board-dist/index.html')).href)
  await page.getByRole('button', { name: 'Stash a new fiber (n)', exact: true }).click()
  const stashSurface = page.getByRole('combobox', { name: 'Session', exact: true })
  assert.equal(await stashSurface.count(), 0, 'a default (Claude) stash has no session choice')
  const stashAgent = page.locator('select').filter({ has: page.locator('option[value="codex-luna"]') })
  await stashAgent.selectOption('codex-luna')
  assert.equal(await stashSurface.inputValue(), 'app', 'new Codex stash defaults to app')
  await stashSurface.selectOption('cli')
  assert.equal(await stashSurface.inputValue(), 'cli', 'Codex stash still offers Terminal')
  assert.deepEqual(errors, [])
  console.log('Capture/Stash/session choices, desktop/phone geometry, live settings without dispatch, drawer strip, session history links, Standing confirmation, parent Escape, kind rollback, due-follows-kind, meeting menu, Resume and Discard passed')
} finally {
  await browser.close()
}
