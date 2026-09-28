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
  // Every session-ledger read the page makes from here on, in order.
  await page.evaluate(() => {
    window.sessionReads = []
    const originalFetch = window.fetch
    window.fetch = (input, init) => {
      if (String(input).includes('/api/v1/sessions')) window.sessionReads.push(String(input))
      return originalFetch(input, init)
    }
  })
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
  // History: folded, and read only when unfolded.
  const historyToggle = page.locator('.kbn-ctl-history-toggle')
  assert.equal(await historyToggle.getAttribute('aria-expanded'), 'false', 'history starts folded')
  assert.equal(await page.locator('.kbn-ctl-sessions').isVisible(), false, 'folded history shows no list')
  assert.equal(await page.locator('.kbn-ctl-session').count(), 0, 'nothing drawn before the unfold')
  if (process.env.SCREENSHOT_DIR) {
    await page.locator('.kbn-ctl-history').screenshot({ path: resolve(process.env.SCREENSHOT_DIR, 'history-folded-phone.png') })
  }
  assert.deepEqual(await page.evaluate(() => window.sessionReads), [], 'nothing is read before the unfold')
  await historyToggle.click()
  assert.equal(await historyToggle.getAttribute('aria-expanded'), 'true')
  // Rows are drawn from the ledger at once, before any host answers: each
  // already resumes, and no web page is known yet.
  const sessionRows = page.locator('.kbn-ctl-session')
  await sessionRows.first().waitFor()
  assert.equal(await sessionRows.count(), 6, 'the unfolded history shows six sessions')
  assert.equal(await page.locator('.kbn-ctl-session-link.kbn-ctl-session-terminal').count(), 5, 'rows are drawn before their links')
  assert.equal(await page.locator('.kbn-ctl-session-web').count(), 0, 'no web page before the host answers')
  assert.equal(await page.locator('.kbn-ctl-history-count').innerText(), '8', 'the fold counts every session')
  const reads = await page.evaluate(() => window.sessionReads)
  assert.ok(reads[0].includes('/api/v1/sessions/composite?since_ms=0&uid=01KVBR2G7CXDWMG85592QW78ZZ'), `the ledger read names the card: ${reads[0]}`)
  // Every attach the page asks for, with its body.
  await page.evaluate(() => {
    window.attaches = []
    const originalFetch = window.fetch
    window.fetch = (input, init) => {
      if (String(input).endsWith('/api/v1/attach')) window.attaches.push(JSON.parse(init.body))
      return originalFetch(input, init)
    }
  })
  const claimRow = page.locator('.kbn-ctl-session[data-session="f466597a-56d0-4047-8585-2159281ca18b"]')
  await claimRow.locator('a.kbn-ctl-session-web').waitFor()
  const liveRow = sessionRows.nth(0)
  assert.equal(await liveRow.getAttribute('data-session'), '01a0be38-6c36-7cd1-aec9-53a680d1f693', 'newest first')
  assert.equal(await liveRow.locator('.kbn-ctl-session-live').count(), 1, 'the running session is marked live')
  assert.equal(await liveRow.locator('.kbn-ctl-session-terminal').count(), 0, 'a live app conversation is not taken into a terminal')
  assert.equal(await page.locator('.kbn-ctl-session a[href^="codex:"]').count(), 0, 'no codex thread routes in History')
  assert.deepEqual(
    await claimRow.locator('.kbn-ctl-session-agent, .kbn-ctl-session-kind').allInnerTexts(),
    ['claude-fable', 'claim'],
    'agent, and the kind when it is not a plain dispatch',
  )
  assert.equal(await claimRow.locator('.kbn-ctl-session-terminal').innerText(), 'resume ▸', 'a past session resumes in a terminal')
  const claimApp = claimRow.locator('a.kbn-ctl-session-alt.kbn-ctl-session-app')
  assert.equal(await claimApp.innerText(), 'app ↗')
  assert.equal(await claimApp.getAttribute('href'), 'claude://claude.ai/code/session_01F466597A', 'a bridged session opens in the Claude desktop app')
  assert.equal(await claimApp.getAttribute('target'), null)
  const claimWeb = claimRow.locator('a.kbn-ctl-session-alt.kbn-ctl-session-web')
  assert.equal(await claimWeb.innerText(), 'web ↗')
  assert.equal(await claimWeb.getAttribute('href'), 'https://claude.ai/code/session_01F466597A')
  assert.equal(await claimWeb.getAttribute('target'), '_blank', 'its web page opens in a new tab')
  for (const link of [claimWeb, claimApp]) {
    await link.evaluate(a => a.addEventListener('click', e => e.preventDefault()))
    await link.click()
  }
  assert.deepEqual(await page.evaluate(() => window.attaches), [], 'the app and web links open no terminal')
  const unbridged = page.locator('.kbn-ctl-session[data-session="b69296a4-1023-4231-b372-270d7b3c4a9b"]')
  assert.equal(await unbridged.locator('a').count(), 0, 'an unbridged session has no web page')
  await unbridged.locator('.kbn-ctl-session-when').click()
  // While the request is in flight the row is pending, and a second click is not a second request.
  assert.equal(await unbridged.getAttribute('class'), 'kbn-ctl-session kbn-ctl-session-opens kbn-ctl-session-pending')
  assert.equal(await unbridged.locator('.kbn-ctl-session-terminal').isDisabled(), true)
  await unbridged.locator('.kbn-ctl-session-when').click()
  await page.waitForFunction(() => !document.querySelector('.kbn-ctl-session-pending'))
  assert.equal(await unbridged.locator('.kbn-ctl-session-terminal').innerText(), 'resume ▸')
  assert.deepEqual(
    await page.evaluate(() => window.attaches),
    [{ session: 'b69296a4-1023-4231-b372-270d7b3c4a9b', shuttle_host: 'ada-workstation' }],
    'clicking a row resumes that session on the host that ran it',
  )
  await page.locator('.kbn-ctl-session-more').click()
  assert.equal(await sessionRows.count(), 8, 'all N draws the rest at once')
  const foreign = page.locator('.kbn-ctl-session[data-session="c6239266-4ba7-4b72-9ba0-fb302c75458e"]')
  assert.equal(await foreign.locator('.kbn-ctl-session-host').innerText(), 'basalt-login-02', 'a session run elsewhere names its host')
  const pi = page.locator('.kbn-ctl-session[data-session="01a042f4-6b7f-7f79-9c6c-8140ffd0126c"]')
  await page.waitForTimeout(700)
  assert.equal(await pi.locator('a').count(), 0, 'a pi session has no web page')
  await pi.locator('.kbn-ctl-session-terminal').click()
  await foreign.click()
  assert.deepEqual(
    (await page.evaluate(() => window.attaches)).slice(1),
    [
      { session: '01a042f4-6b7f-7f79-9c6c-8140ffd0126c', shuttle_host: 'ada-workstation' },
      { session: 'c6239266-4ba7-4b72-9ba0-fb302c75458e', shuttle_host: 'basalt-login-02' },
    ],
    'pi resumes too, and a session on a stale host is still resumed there',
  )
  const linkReads = (await page.evaluate(() => window.sessionReads)).filter(url => url.includes('/sessions/links'))
  assert.ok(linkReads.length > 0 && linkReads.every(url => !url.includes('basalt-login-02')), `stale host not asked: ${linkReads}`)
  const historyBox = await page.locator('.kbn-ctl-sessions').boundingBox()
  assert.ok(historyBox && historyBox.x + historyBox.width <= 390, 'phone: the history fits')
  if (process.env.SCREENSHOT_DIR) {
    await page.locator('.kbn-ctl-history').screenshot({ path: resolve(process.env.SCREENSHOT_DIR, 'history-open-phone.png') })
  }
  await historyToggle.click()
  assert.equal(await page.locator('.kbn-ctl-sessions').isVisible(), false, 'the fold closes again')
  assert.equal(await page.locator('.kbn-ctl-history-count').innerText(), '8', 'and keeps its count')

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
  // On a phone every Claude chat opens on claude.ai, and nothing asks for a desktop app.
  const phone = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    reducedMotion: 'reduce',
  })
  await phone.goto(pathToFileURL(resolve('harness-board-dist/index.html')).href)
  await phone.getByText('App conversation continuity', { exact: true }).click()
  await phone.locator('.kbn-detail-controls-toggle').click()
  await phone.locator('.kbn-ctl-history-toggle').click()
  const phoneClaim = phone.locator('.kbn-ctl-session[data-session="f466597a-56d0-4047-8585-2159281ca18b"]')
  await phoneClaim.locator('a.kbn-ctl-session-web').waitFor()
  assert.equal(await phoneClaim.locator('a.kbn-ctl-session-link').getAttribute('href'), 'https://claude.ai/code/session_01F466597A', 'phone: claude.ai is the link')
  await phone.waitForTimeout(600)
  assert.equal(await phone.locator('.kbn-ctl-session-terminal').count(), 0, 'phone: no terminal to open')
  assert.equal(await phone.locator('.kbn-ctl-session a.kbn-ctl-session-app').count(), 0, 'phone: no desktop-app route')
  assert.equal(
    await phone.locator('.kbn-ctl-session[data-session="01a042f4-6b7f-7f79-9c6c-8140ffd0126c"] .kbn-ctl-session-copy').innerText(),
    '01a042f4',
    'phone: an unbridged session copies its id',
  )
  await phone.close()

  console.log('Capture/Stash/session choices, desktop/phone geometry, live settings without dispatch, drawer strip, history fold and row actions (resume with pending state, app, web, copy; desktop and phone), Standing confirmation, parent Escape, kind rollback, due-follows-kind, meeting menu, Resume and Discard passed')
} finally {
  await browser.close()
}
