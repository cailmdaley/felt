// Browser voice journeys use the real board and a synthetic recorder.
// Warm speech stays above the composer; cold speech becomes an editable draft.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
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
    const chip = selected.locator('.kbn-ctl-meet-arm')
    const meeting = selected.locator('.kbn-ctl-meet')
    const send = selected.getByRole('button', { name: 'Start ↵', exact: true })
    const geometry = await page.evaluate(() => {
      const el = document.querySelector('.ws-page.ws-selected .kbn-ctl-meet-label')
      return { width: el.getBoundingClientRect().width, scroll: el.scrollWidth, client: el.clientWidth }
    })
    assert.ok(geometry.scroll > geometry.client, 'long name is ellipsized')
    assert.ok(await meeting.isVisible(), 'Listening remains visible')
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
    assert.ok(await pending.evaluate(el => el.closest('.kbn-ctl-composer') !== null), 'pending speech sits inside the composer')
    const after = await selected.locator('.kbn-ctl-composer').boundingBox()
    assert.ok(Math.abs(after.y + after.height - before.y - before.height) < 1, 'pending speech grows the composer upward')
    await selected.locator('.kbn-ctl-meet-dropdown').click()
    assert.ok(await page.getByRole('menuitem', { name: 'Pause', exact: true }).isVisible())
    await page.screenshot({ path: `${process.env.HARK_SCREENSHOT_DIR || '/tmp'}/hark-${scheme}.png` })
    await page.keyboard.press('Escape')
    await page.evaluate(() => {
      const voice = window.__harness.modal.voice
      voice.status = { ...voice.status, state: 'yielded', pending: null, preview: null }
      voice.notify()
    })
    const elsewhere = selected.locator('.voice-pending.voice-elsewhere')
    await elsewhere.waitFor()
    assert.equal(await elsewhere.textContent(), 'Your voice is going to a recording, not this chat.')
    assert.ok(await elsewhere.isVisible(), 'the composer says where the mic is going')
    await page.screenshot({ path: `${process.env.HARK_SCREENSHOT_DIR || '/tmp'}/hark-elsewhere-${scheme}.png` })
    await context.close()
  }
  await mkdir(process.env.HARK_SCREENSHOT_DIR || '/tmp', { recursive: true })
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, reducedMotion: 'reduce' })
    await context.addInitScript(scheme => localStorage.setItem('shuttle.appearance', JSON.stringify({ mode: scheme, dark: 'night-chart' })), scheme)
    const page = await context.newPage()
    await page.goto(`${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=music&transcript=live`)
    await page.locator('.kbn-desk .kbn-card').filter({ hasText: 'Music' }).first().click()
    const selected = page.locator('.ws-page.ws-selected')
    const field = selected.locator('textarea')
    await field.waitFor()
    await field.fill('A typed note before the speech.')
    await field.evaluate(el => { el.focus(); el.setSelectionRange(2, 7, 'backward') })
    await page.evaluate(() => {
      const modal = window.__harness.modal, voice = modal.voice
      voice.dispose()
      const cold = voice.card
      const live = modal.workspaceCards().find(card => card.name === 'Calibrate the shear response')
      window.__coldVoiceCards = { cold, live }
      const text = 'S1: Keep this thought here until I decide to send it.'
      const held = { id: 'held-music', fiber_id: cold.uid ?? cold.id, origin: cold.originId, after: 0, through: 1, text, segments: [{ through: 1, text }] }
      window.__coldVoiceState = { available: true, enabled: true, muted: false, state: 'listening', cold: true, held: [held], target: { fiber_id: held.fiber_id, origin: held.origin, name: cold.name }, preview: { fiber_id: held.fiber_id, origin: held.origin, text: 'S1: A few words still being recognized…' }, pending: null, last: null, error: null }
      window.__coldVoiceRequests = []
      const fetch = window.fetch
      window.fetch = async (url, init) => {
        const path = String(url), state = window.__coldVoiceState
        const body = init?.body ? JSON.parse(init.body) : null
        if (path.includes('/api/v1/voice')) {
          if (body) window.__coldVoiceRequests.push({ path, body })
          if (path.endsWith('/draft') || path.endsWith('/release')) {
            const held = state.held[0]
            if (!held || body.id !== held.id || body.after !== held.after || body.through !== held.through) {
              return new Response('{}', { status: 409 })
            }
          }
          if (path.endsWith('/draft')) {
            state.held[0].segments = [{ through: body.through, text: body.text }]
            state.held[0].text = body.text
          }
          if (path.endsWith('/release')) {
            state.held = []
            if (window.__coldVoiceReleaseFailure) throw new TypeError('Release response lost')
          }
          return new Response(JSON.stringify(state), { headers: { 'Content-Type': 'application/json' } })
        }
        if (path.includes('/api/v1/dispatch')) window.__coldVoiceRequests.push({ path, body })
        return fetch(url, init)
      }
      voice.status = structuredClone(window.__coldVoiceState); voice.notify()
    })
    assert.equal(await field.inputValue(), 'A typed note before the speech.\n\nS1: Keep this thought here until I decide to send it.')
    assert.deepEqual(await field.evaluate(el => [el.selectionStart, el.selectionEnd, el.selectionDirection]), [2, 7, 'backward'])
    assert.equal(await selected.locator('.kbn-ctl-meet-arm').innerText(), 'Listening · Music')
    assert.equal(await selected.locator('.voice-pending').innerText(), 'S1: A few words still being recognized…')
    await page.evaluate(() => {
      const state = window.__coldVoiceState
      state.held[0].through = 2; state.held[0].text += ' There is no rush.'
      state.held[0].segments.push({ through: 2, text: ' There is no rush.' })
      window.__harness.modal.voice.status = structuredClone(state); window.__harness.modal.voice.notify()
    })
    assert.deepEqual(await field.evaluate(el => [el.selectionStart, el.selectionEnd]), [2, 7])
    await field.fill((await field.inputValue()).replace('There is no rush.', 'I can edit this before sending.'))
    await page.waitForFunction(() => window.__coldVoiceRequests.some(row => row.path.endsWith('/draft')))
    const edited = await field.inputValue()
    await page.evaluate(() => {
      const { live } = window.__coldVoiceCards, state = window.__coldVoiceState, modal = window.__harness.modal
      state.target = { fiber_id: live.uid ?? live.id, origin: live.originId, name: live.name }; state.cold = false
      modal.voice.status = structuredClone(state); modal.voice.notify(); modal.openDocumentChannel(live, true)
    })
    await selected.locator('.ws-chat-title').filter({ hasText: 'Calibrate the shear response' }).waitFor()
    assert.equal(await selected.locator('textarea').inputValue(), '', 'the live card does not inherit the dormant card\'s speech')
    assert.equal(await selected.locator('.kbn-ctl-meet-arm').innerText(), 'Listening · Calibrate the shear response')
    await page.evaluate(() => {
      const { cold } = window.__coldVoiceCards, state = window.__coldVoiceState, modal = window.__harness.modal
      state.target = { fiber_id: cold.uid ?? cold.id, origin: cold.originId, name: cold.name }; state.cold = true
      modal.voice.status = structuredClone(state); modal.voice.notify(); modal.openDocumentChannel(cold, true)
    })
    await selected.locator('.ws-chat-title').filter({ hasText: 'Music' }).waitFor()
    assert.equal(await field.inputValue(), edited, 'held edits survive switching cards')
    assert.equal(await selected.locator('.kbn-ctl-meet').count(), 1, 'one Hark control')
    await page.screenshot({ path: `${process.env.HARK_SCREENSHOT_DIR || '/tmp'}/hark-held-${scheme}.png` })
    await selected.locator('.kbn-ctl-sends .kbn-ctl-send:not(.kbn-ctl-resume)').click()
    await page.waitForFunction(() => window.__coldVoiceRequests.some(row => row.path.includes('/dispatch')))
    await page.waitForFunction(() => document.querySelector('.ws-page.ws-selected textarea')?.value === '')
    const sent = await page.evaluate(() => window.__coldVoiceRequests.filter(row => row.path.endsWith('/release') || row.path.includes('/dispatch')))
    assert.deepEqual(sent.map(row => row.path), ['/api/v1/voice/release', '/api/v1/dispatch'])
    assert.deepEqual(sent[0].body, { id: 'held-music', after: 0, through: 2 })
    assert.equal(sent[1].body.user_message, edited)
    assert.ok(!sent[1].body.user_message.includes('still being recognized'), 'raw preview is never sent')
    await page.evaluate(() => {
      const { live } = window.__coldVoiceCards, state = window.__coldVoiceState, modal = window.__harness.modal
      state.target = { fiber_id: live.uid ?? live.id, origin: live.originId, name: live.name }; state.cold = false
      modal.voice.status = structuredClone(state); modal.voice.notify(); modal.openDocumentChannel(live, true)
    })
    await selected.locator('.ws-chat-title').filter({ hasText: 'Calibrate the shear response' }).waitFor()
    await selected.locator('textarea').fill('A direct message to the live worker.')
    await selected.locator('.kbn-ctl-resume').click()
    await page.waitForFunction(() => window.__coldVoiceRequests.filter(row => row.path.includes('/dispatch')).length === 2)
    const liveSend = await page.evaluate(() => window.__coldVoiceRequests.filter(row => row.path.includes('/dispatch')).at(-1).body)
    assert.equal(liveSend.user_message, 'A direct message to the live worker.')
    assert.equal(liveSend.resume_mode, 'previous')
    assert.equal(await page.evaluate(() => window.__coldVoiceRequests.filter(row => row.path.endsWith('/release')).length), 1)

    // A partial name claim keeps the same id and through; only after changes.
    await page.evaluate(() => window.__harness.modal.openDocumentChannel(window.__coldVoiceCards.cold, true))
    await selected.locator('.ws-chat-title').filter({ hasText: 'Music' }).waitFor()
    await field.fill('A second typed note.')
    await page.evaluate(() => {
      const { cold } = window.__coldVoiceCards, state = window.__coldVoiceState, voice = window.__harness.modal.voice
      state.cold = true; state.target = { fiber_id: cold.uid ?? cold.id, origin: cold.originId, name: cold.name }
      state.held = [{ id: 'held-remainder', fiber_id: cold.uid ?? cold.id, origin: cold.originId, after: 0, through: 2, text: 'S1: Already claimed. hello world', segments: [{ through: 1, text: 'S1: Already claimed.' }, { through: 2, text: ' hello world' }] }]
      voice.status = structuredClone(state); voice.notify()
    })
    await field.fill((await field.inputValue()) + '\nA typed suffix.')
    await page.evaluate(() => {
      const state = window.__coldVoiceState, voice = window.__harness.modal.voice
      state.held[0].after = 1; state.held[0].text = 'S1: hello world'
      state.held[0].segments = [{ through: 2, text: 'S1: hello world' }]
      voice.status = structuredClone(state); voice.notify()
    })
    assert.equal(await field.inputValue(), 'A second typed note.\n\nS1: hello world\nA typed suffix.')
    await field.fill((await field.inputValue()).replace('hello world', 'hello'))
    await page.evaluate(() => window.__harness.modal.voice.writes)
    assert.deepEqual(await page.evaluate(() => window.__coldVoiceRequests.filter(row => row.path.endsWith('/draft')).at(-1).body), { id: 'held-remainder', after: 1, through: 2, text: 'S1: hello' })
    await page.evaluate(() => {
      const state = window.__coldVoiceState, voice = window.__harness.modal.voice
      state.held[0].through = 3; state.held[0].text = 'S1: hello world'
      state.held[0].segments.push({ through: 3, text: ' world' })
      voice.status = structuredClone(state); voice.notify()
    })
    const recovered = await field.inputValue()
    assert.equal(recovered, 'A second typed note.\n\nS1: hello world\nA typed suffix.', 'acknowledged deletion does not swallow repeated speech')
    await page.evaluate(() => { window.__coldVoiceReleaseFailure = true })
    await selected.locator('.kbn-ctl-sends .kbn-ctl-send:not(.kbn-ctl-resume)').click()
    await page.waitForFunction(() => document.querySelector('.ws-page.ws-selected')?.textContent.includes('Check the worker'))
    await page.evaluate(() => {
      const voice = window.__harness.modal.voice
      voice.status = structuredClone(window.__coldVoiceState); voice.notify()
    })
    assert.equal(await field.inputValue(), recovered, 'lost release response retains the edited draft after an empty poll')
    assert.equal(await page.evaluate(() => window.__coldVoiceRequests.filter(row => row.path.includes('/dispatch')).length), 2, 'uncertain release never dispatches or retries automatically')
    assert.deepEqual(await page.evaluate(() => window.__coldVoiceRequests.filter(row => row.path.endsWith('/release')).at(-1).body), { id: 'held-remainder', after: 1, through: 3 })
    await page.screenshot({ path: `${process.env.HARK_SCREENSHOT_DIR || '/tmp'}/hark-recovery-${scheme}.png` })
    await context.close()
  }
  console.log('voice layout, editable cold hold, dormant start, live send, partial consumption, repeated speech and uncertain-release recovery: ok (light + dark)')
} finally { await browser.close() }
