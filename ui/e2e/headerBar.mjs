import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { familyTree, openThread, sentFiles, threadRow } from './familyNav.mjs'
import { closeVerbMenu, consoleAct, consoleMenu, hitBox, offeredVerbs, verbCaret, verbFace, verbMenu } from './verbs.mjs'

const title = 'Calibrate the shear response across independent sky patches and validate each redshift bin'
const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=threads&long-title`
const named = (page, name) => page.waitForFunction(name => document.querySelector('.ws-stage-band .ws-band-title')?.title === name, name)
/** A thread's band names it after its family's root, whose page it opens on; a draft opens on its own. */
const threadNamed = (page, name) => page.waitForFunction(names => names.includes(document.querySelector('.ws-stage-band .ws-band-title')?.title), [name, `${title} / ${name}`])
const band = page => page.locator('.ws-stage-band')
/** The console's acts: its menu, and where a verdict's undo stands. */
const consoleActs = page => band(page).locator('.ws-band-head .ws-band-acts')
/**
 * The fiber's acts where they show: its view's head; on a page with no view
 * for the fiber, the console's, which carries no verb.
 */
const acts = page => page.locator('.ws-reader:not(:has(.ws-page.ws-selected .ov-head .ws-fiber-acts)) .ws-stage-band .ws-band-head .ws-band-acts')
  .or(page.locator('.ws-page.ws-selected .ov-head .ov-tools > .ws-fiber-acts'))
async function openRoot(page) {
  // Click the row's own name: its crumb leads to the root.
  const name = page.locator(`.kbn-desk .kbn-family[title*="${title}"] > :first-child`).first().locator(':is(.kbn-family-name, .thread-row-slug)')
  const box = await name.boundingBox()
  await name.click({ position: { x: box.width - 6, y: box.height / 2 } })
  await band(page).locator('.ws-dock').waitFor()
  // A family's Desk row opens its frontier's view; these journeys exercise the root, its topmost orchestrator.
  if (await band(page).locator('.ws-band-title').getAttribute('title') !== title) {
    await page.locator('.ws-page.ws-selected .ov-ancestor').first().click()
  }
  await named(page, title)
  await acts(page).waitFor()
}
// Find highlights the thread whose lifecycle the band acts on.
async function visitChannel(page, name) {
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('/')
  const find = page.locator('.kbn-viewtabs-find input')
  // In the reader Find searches the constitution shown; Backspace widens it to the board.
  await find.press('Backspace')
  await find.fill(name)
  await page.locator('.ws-switcher .ws-channel-row').filter({ has: page.getByText(name, { exact: true }) }).click()
  await threadNamed(page, name)
}
/** The lifecycle verbs the shown acts offer, by word: the verb button's face, then its menu's. */
const shownVerbs = page => offeredVerbs(acts(page))
/** The message box's verbs under the band's head. */
const workerVerbs = page => page.locator('.ws-stage-band .ws-worker-acts button[data-verb]').evaluateAll(buttons =>
  buttons.filter(button => button.checkVisibility()).map(button => button.dataset.verb))
const assertLifecycleInk = async (page, scheme) => {
  const strip = acts(page)
  // A fiber off the Desk has no acts to draw.
  if (!await strip.count()) return
  const renderedTheme = await strip.evaluate(el => ({
    appearance: document.documentElement.dataset.wsAppearance,
    pageTheme: el.closest('.ws-reader')?.dataset.wsThemeName,
  }))
  assert.equal(renderedTheme.appearance, scheme, `the document resolves to ${scheme}: ${JSON.stringify(renderedTheme)}`)
  assert.equal(renderedTheme.pageTheme, scheme === 'dark' ? 'night-chart' : 'portolan', `the selected page uses the ${scheme} bundled theme: ${JSON.stringify(renderedTheme)}`)
  // A row draws its verbs on its strip; the console in its menu.
  const onConsole = await consoleMenu(strip).isVisible()
  if (onConsole) { await consoleMenu(strip).click(); await verbMenu(page).waitFor() }
  const verbs = await (onConsole ? verbMenu(page).locator('[role="menuitem"][data-verb]') : strip.locator('.ws-acts-verbs > button')).evaluateAll(buttons => buttons
    .filter(button => button.checkVisibility())
    .map(button => {
      const style = getComputedStyle(button)
      return {
        label: button.dataset.verb,
        pigment: style.getPropertyValue('--verdict-pigment').trim(),
        color: style.color,
        // The menu's highlighted item is inked up for the keyboard, as hover inks any act.
        highlighted: !!button.closest('[data-highlighted]'),
      }
    }))
  // Neutral ink as the strip or menu resolves it, in the same zone as its verbs.
  const neutral = await (onConsole ? verbMenu(page).locator('[role="menuitem"][data-verb]').first() : strip).evaluate(el => {
    const sample = document.createElement('span')
    sample.style.cssText = 'position:fixed;left:-9999px;color:var(--ws-ink-muted)'
    el.append(sample)
    const color = getComputedStyle(sample).color
    sample.remove()
    return color
  })
  if (onConsole) await closeVerbMenu(page)
  for (const verb of verbs) {
    if (['Temper', 'Discard'].includes(verb.label)) {
      assert.ok(verb.pigment, `${verb.label} carries verdict pigment`)
    } else {
      assert.equal(verb.pigment, '', `${verb.label} has no verdict pigment: ${JSON.stringify(verb)}`)
      if (!verb.highlighted) assert.equal(verb.color, neutral, `${verb.label} uses the shared neutral ink: ${JSON.stringify(verb)}`)
    }
  }
}
async function captureListenState(page, scene, width, scheme) {
  if (!process.env.WORKSPACE_SHOTS) return
  const height = width < 500 ? 844 : 900
  await mkdir(process.env.WORKSPACE_SHOTS, { recursive: true })
  await page.waitForFunction(width => window.innerWidth === width, width)
  await page.mouse.move(width - 2, height - 2)
  await page.screenshot({
    path: resolve(process.env.WORKSPACE_SHOTS, `listen-${scene}-${width}-${scheme}.png`),
    animations: 'disabled',
  })
}
export function registerHeaderBarJourneys(test) {
  test("Lifecycle state selects a fiber's verbs; only verdicts carry pigment", async page => {
    await page.addInitScript(() => {
      if (window !== window.top) return
      const scheme = new URLSearchParams(location.search).get('e2e-appearance') || 'light'
      localStorage.setItem('shuttle.appearance', JSON.stringify({ mode: scheme, dark: 'night-chart' }))
    })
    for (const scheme of ['light', 'dark']) {
      await page.goto(`${url}&e2e-appearance=${scheme}`)
      await openRoot(page)
      assert.deepEqual(await shownVerbs(page), ['Temper', 'Rest', 'Discard'], 'Awaiting review leads with Temper and offers the rest')
      assert.deepEqual(await workerVerbs(page), ['Resume', 'New session'])
      await assertLifecycleInk(page, scheme)
      const visits = [
        ['Response analysis', ['Close for review', 'Rest', 'Temper', 'Discard'], ['Send', 'New session']],
        // A draft opens on its view too, whose head carries its acts.
        ['Draft the validation plan', ['Close for review', 'Rest', 'Temper', 'Discard'], ['Start']],
        ['Next validation', [], ['Start']],
        ['Accepted pilot', ['Rest'], ['Start']],
        ['Discarded pilot', ['Rest'], ['Start']],
      ]
      for (const [name, verbs, worker] of visits) {
        await visitChannel(page, name)
        assert.deepEqual(await shownVerbs(page), verbs, `${name} draws the verbs its state offers`)
        assert.deepEqual(await workerVerbs(page), worker, `${name} offers its worker's verbs`)
        await assertLifecycleInk(page, scheme)
      }
    }
  }, { width: 1000, height: 900 })
  test("Width changes keep visible focus on the view's acts", async page => {
    await page.goto(url)
    await openRoot(page)
    const focused = locator => locator.evaluate(el => el === document.activeElement)
    for (const [name, control] of [['Settings', acts(page).locator('.ws-acts-settings')], ['Temper', verbFace(acts(page))], ['Constitution', page.locator('.ws-page.ws-selected .ov-head [data-part="constitution"]')]]) {
      await control.focus()
      for (const width of [850, 390, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        assert.ok(await focused(control), `${name} keeps focus at ${width}`)
        assert.ok(await control.isVisible(), `${name} stays drawn at ${width}`)
      }
    }
  }, { width: 1440, height: 900 })
  test('The band title holds one line down to a 701px viewport, with the verbs its state selects on the row', async page => {
    await page.goto(url)
    await openRoot(page)
    const header = page.locator('.ws-stage-band .ws-band-head')
    for (const width of [1440, 850, 701]) {
      await page.setViewportSize({ width, height: 900 })
      const geometry = await header.locator('h1').evaluate(el => ({ height: el.clientHeight, line: parseFloat(getComputedStyle(el).lineHeight), wrap: getComputedStyle(el).whiteSpace, overflow: getComputedStyle(el).textOverflow }))
      assert.deepEqual([geometry.wrap, geometry.overflow], ['nowrap', 'ellipsis'])
      assert.ok(geometry.height <= geometry.line + 1, JSON.stringify(geometry))
      assert.equal(await header.locator('h1').getAttribute('title'), title)
      assert.deepEqual(await shownVerbs(page), ['Temper', 'Rest', 'Discard'], `Awaiting review draws its verbs in its view's head at ${width}`)
    }
  }, { width: 1440, height: 900 })
  test('The band keeps its title and controls on one line, and the view\'s head its acts, which the band does not repeat, inside open desktop columns', async page => {
    await page.goto(url)
    await openRoot(page)
    const header = page.locator('.ws-stage-band .ws-band-head')
    let labelSize
    const check = async () => {
      const sizes = await header.locator('.ws-header-icon').evaluateAll(els => els.filter(el => el.checkVisibility()).map(el => el.getBoundingClientRect().height))
      labelSize ??= sizes[0]
      assert.ok(sizes.every(size => size === labelSize), `every band control keeps one height: ${sizes}`)
      // Over the view, whose head carries them, the console repeats none of its pages and acts.
      assert.equal(await page.locator('.ws-stage-band .ws-band-acts > :is(.ws-band-buttons, .ws-band-menu):visible').count(), 0)
      const centres = await header.locator('.ws-header-icon, h1').evaluateAll(els => els.filter(el => el.checkVisibility()).map(el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 }))
      assert.ok(Math.max(...centres) - Math.min(...centres) < 1.5, `the band's head keeps one centre line: ${centres}`)
      assert.ok(await header.locator('h1').evaluate(el => el.clientHeight <= parseFloat(getComputedStyle(el).lineHeight) + 1))
      // The view's head draws every act inside the page, in the head.
      await page.waitForFunction(() => {
        const strip = document.querySelector('.ws-page.ws-selected .ov-head .ws-fiber-acts')
        const page = strip?.closest('.ws-page')?.getBoundingClientRect(), row = strip?.closest('.ov-head')?.getBoundingClientRect()
        return strip && page && row && [...strip.querySelectorAll('button, a')].filter(control => control.checkVisibility()).every(control => {
          const b = control.getBoundingClientRect()
          return b.left >= page.left && b.right <= page.right && b.top >= row.top - 4 && b.bottom <= row.bottom + 4
        })
      })
      assert.ok(await verbFace(acts(page)).isVisible() && await verbCaret(acts(page)).isVisible(), 'the verb button stays drawn')
      assert.deepEqual(await shownVerbs(page), ['Temper', 'Rest', 'Discard'], 'Temper leads and Discard stays a menu away')
    }
    for (const width of [1440, 850, 701, 1440]) {
      await page.setViewportSize({ width, height: 900 }); await check()
      if (process.env.WORKSPACE_SHOTS && width === 701) await page.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, 'header-narrow-desktop-light.png') })
    }
  }, { width: 1440, height: 900 })
  test("The 390px phone band leaves the name to the top bar; the view's head carries its pages and acts", async page => {
    await page.addInitScript(() => {
      if (window !== window.top) return
      localStorage.setItem('shuttle.appearance', JSON.stringify({ mode: 'light' }))
    })
    await page.goto(url)
    await openRoot(page)
    const assertRow = async (expected, width = 390) => {
      assert.deepEqual(await shownVerbs(page), expected)
      const strip = acts(page)
      const row = await strip.boundingBox()
      assert.ok(row.x >= 0 && row.x + row.width <= width, `the acts fit the phone: ${JSON.stringify(row)}`)
      const centres = await strip.locator('button:visible, a:visible').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 }))
      assert.ok(centres.length >= 2 && Math.max(...centres) - Math.min(...centres) < 2, `the acts share one line: ${centres}`)
      // Under the name: the pages, then the acts.
      const lines = await strip.evaluate(el => {
        const head = el.closest('.ov-head'), name = head.querySelector('.ov-name').getBoundingClientRect(), docs = head.querySelector('.ws-doc-buttons').getBoundingClientRect(), own = el.getBoundingClientRect()
        return { below: own.top >= name.bottom - 1 && docs.top >= name.bottom - 1 }
      })
      assert.ok(lines.below, `the pages and acts stand under the name: ${JSON.stringify(lines)}`)
      // Every act is a full touch target in reach: its hit area (the pill's drawing grows to it) is 44px tall.
      for (const [name, control] of [['the verb face', verbFace(strip)], ['the caret', verbCaret(strip)], ['Settings', strip.locator('.ws-acts-settings')]]) {
        if (name === 'the caret' && expected.length < 2) continue
        const reach = await hitBox(control)
        assert.ok(reach.x >= 0 && reach.x + reach.width <= width + 1 && reach.height >= 44, `${name} is a full touch target in reach: ${JSON.stringify(reach)}`)
      }
    }
    await assertRow(['Temper', 'Rest', 'Discard'])
    // A thread opens from its row in the view, one level down.
    await threadRow(page, await familyTree(page), 'analysis').click()
    await threadNamed(page, 'Response analysis')
    await assertRow(['Close for review', 'Rest', 'Temper', 'Discard'])
    const reviewInk = await verbFace(acts(page)).evaluate(el => {
      const neutral = document.createElement('span')
      neutral.style.color = 'var(--ws-ink-muted, var(--kbn-ink-muted))'
      el.parentElement.append(neutral)
      const result = {
        pigment: getComputedStyle(el).getPropertyValue('--verdict-pigment').trim(),
        color: getComputedStyle(el).color,
        neutral: getComputedStyle(neutral).color,
      }
      neutral.remove()
      return result
    })
    assert.equal(reviewInk.pigment, '', `Close for review has no verdict pigment: ${JSON.stringify(reviewInk)}`)
    assert.equal(reviewInk.color, reviewInk.neutral, `Close for review uses neutral lifecycle ink: ${JSON.stringify(reviewInk)}`)
    if (process.env.WORKSPACE_SHOTS) {
      await mkdir(process.env.WORKSPACE_SHOTS, { recursive: true })
      await page.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, 'working-phone-light.png') })
    }
  }, { width: 390, height: 844 })
  test('Listen stays one control inside the message box at every width', async page => {
    await page.goto(url); await openRoot(page)
    const box = page.locator('.ws-stage-band .ws-worker-acts')
    for (const width of [1440, 1000, 701, 390, 320]) {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 900 })
      const arm = box.locator('.listen-mic')
      const [outer, control] = await Promise.all([box.boundingBox(), box.locator('.listen-control').boundingBox()])
      assert.ok(control.x >= outer.x - 1 && control.x + control.width <= outer.x + outer.width + 1 && control.y >= outer.y - 1 && control.y + control.height <= outer.y + outer.height + 1, `Listen sits inside the message box at ${width}: ${JSON.stringify({ outer, control })}`)
      assert.ok(outer.x >= 0 && outer.x + outer.width <= width, `the message box fits the viewport at ${width}`)
      assert.equal(await box.locator('.listen-control').count(), 1)
      assert.equal(await arm.getAttribute('aria-label'), 'Listen')
      if (process.env.WORKSPACE_SHOTS && [1440, 390, 320].includes(width)) {
        await mkdir(process.env.WORKSPACE_SHOTS, { recursive: true })
        await page.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, `listen-band-control-${width}-light.png`) })
      }
    }
  }, { width: 1440, height: 900 })
  test('Listen keeps its pin while another card is viewed, with Stop in its menu', async page => {
    await page.goto(`${url}&voice=pinned`)
    await openRoot(page)
    const band = page.locator('.ws-stage-band')
    await band.locator('.listen-mic').waitFor({ state: 'visible' })
    assert.equal(await band.locator('.ws-voice-strip').getAttribute('data-mode'), 'pinned')
    assert.match(await band.locator('.ws-voice-strip').textContent(), /^📌 /)
    assert.equal(await band.locator('.listen-control').count(), 1)
    await band.locator('.listen-dropdown').click()
    assert.ok(await page.getByRole('menuitem', { name: 'Stop listening', exact: true }).isEnabled())
    assert.ok(await page.getByRole('menuitem', { name: "Today's transcript", exact: true }).isEnabled())
    await page.keyboard.press('Escape')
    await page.locator('.kbn-viewtab[data-view="desk"]').click()
    await page.locator(`.kbn-desk .kbn-family[title*="Remote covariance review"] > :first-child`).click()
    const foreign = page.locator('.ws-stage-band')
    assert.equal(await foreign.locator('.ws-voice-strip').getAttribute('data-mode'), 'pinned')
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await captureListenState(page, 'single-recording-menu', width, 'light')
    }
    await foreign.locator('.listen-dropdown').click()
    await page.getByRole('menuitem', { name: 'Stop listening', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.ws-stage-band .listen-mic')?.getAttribute('aria-label') === 'Listen')
  }, { width: 1000, height: 900 })
  test('Listen turns following on, the mic mutes it, and Stop in the menu ends it', async page => {
    await page.goto(url)
    await openRoot(page)
    const band = page.locator('.ws-stage-band')
    const chip = band.locator('.listen-mic')
    await chip.waitFor({ state: 'visible' })
    assert.equal(await chip.getAttribute('aria-label'), 'Listen')
    await chip.click()
    await page.waitForFunction(() => document.querySelector('.ws-stage-band .ws-voice-strip')?.dataset.mode === 'following')
    await chip.click()
    await page.waitForFunction(() => document.querySelector('.ws-stage-band .listen-muted'))
    await band.locator('.listen-dropdown').click()
    await page.getByRole('menuitem', { name: 'Stop listening', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.ws-stage-band .listen-mic')?.getAttribute('aria-label') === 'Listen' && document.querySelector('.ws-stage-band .ws-voice-strip')?.hidden)
    const posts = await page.evaluate(() => window.__harness.requests.filter(r => r.method === 'POST' && r.url.endsWith('/api/v1/voice')).map(r => JSON.parse(r.body)))
    assert.deepEqual(posts, [{ enabled: true, muted: false, source: 'desktop', recorder: 'local' }, { muted: true, recorder: 'local' }, { enabled: false, recorder: 'local' }])
  }, { width: 1000, height: 900 })
  test('Thread rows own Enter while body focus keeps expand and paging shortcuts', async page => {
    await page.goto(url)
    await openRoot(page)
    const press = async target => { await target.focus(); await page.keyboard.press('Enter') }
    await openThread(page, threadRow(page, await familyTree(page), 'analysis'), 'Response analysis', press)
    // Up again, by the orchestrator's head above.
    await openThread(page, (await familyTree(page)).locator('.ov-ancestor').filter({ has: page.locator('.thread-row-slug', { hasText: /^calibration-report$/ }) }), title, press)
    await page.evaluate(() => { document.activeElement?.blur(); document.body.focus() })
    // Expand is a key, Enter or o, with no button of its own.
    assert.equal(await page.locator('.ws-expand-button').count(), 0)
    for (const key of ['Enter', 'o']) {
      await page.keyboard.press(key)
      await page.waitForFunction(() => document.querySelector('.ws-reader').classList.contains('ws-expand-mode'))
      await page.keyboard.press(key)
      await page.waitForFunction(() => !document.querySelector('.ws-reader').classList.contains('ws-expand-mode'))
    }
    await page.setViewportSize({ width: 1440, height: 400 })
    // The constitution's own page, receded behind its family's.
    await page.locator('.ws-page[data-key^="fiber:"]').first().dispatchEvent('click')
    await page.locator('.ws-page.ws-selected[data-key^="fiber:"]').waitFor()
    await page.evaluate(() => { document.activeElement?.blur(); document.body.focus() })
    const scroller = page.locator('.ws-selected .ws-prose-scroll')
    await page.waitForFunction(() => {
      const el = document.querySelector('.ws-selected .ws-prose-scroll')
      return el && el.scrollHeight > el.clientHeight
    })
    await scroller.evaluate(el => { el.scrollTop = 0 })
    await page.keyboard.press('Space')
    await page.waitForFunction(() => document.querySelector('.ws-selected .ws-prose-scroll').scrollTop > 0)
  }, { width: 1440, height: 900 })
  for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    for (const scheme of ['light', 'dark']) test(`A thread's view stands under its orchestrators, named by slugs (${device}, ${scheme})`, async page => {
      await page.addInitScript(scheme => {
        if (window !== window.top) return
        localStorage.setItem('shuttle.appearance', JSON.stringify({ mode: scheme, dark: 'night-chart' }))
      }, scheme)
      await page.goto(url)
      await openRoot(page)
      const head = () => page.locator('.ws-page.ws-selected .ov-head')
      assert.equal(await head().locator('.ov-name').innerText(), 'calibration-report')
      // Down two levels, each its own view under its orchestrators, the family's root first.
      for (const [slug, name] of [['analysis', 'Response analysis'], ['question', 'Choose the response cut']]) {
        await openThread(page, threadRow(page, await familyTree(page), slug), name)
        assert.equal(await page.locator('.ws-page.ws-selected .ov-ancestor .thread-row-slug').first().textContent(), 'calibration-report')
        assert.ok(await head().locator('.ov-title > .constitution-state-dot').isVisible())
      }
      assert.equal(await head().locator('.ov-name').innerText(), 'question')
      if (process.env.WORKSPACE_SHOTS) {
        await mkdir(process.env.WORKSPACE_SHOTS, { recursive: true })
        await page.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, `family-${device}-${scheme}.png`) })
      }
      await openThread(page, page.locator('.ws-page.ws-selected .ov-ancestor').filter({ has: page.locator('.thread-row-slug', { hasText: /^calibration-report$/ }) }), title)
    }, viewport)
    for (const scheme of ['light', 'dark']) test(`One band (${device}, ${scheme}): long name, icons and unified settings`, async page => {
      await page.emulateMedia({ colorScheme: scheme })
      await page.addInitScript(scheme => {
        if (window !== window.top) return
        localStorage.setItem('shuttle.appearance', JSON.stringify({ mode: scheme, dark: 'night-chart' }))
      }, scheme)
      await page.goto(url)
      await openRoot(page)
      const header = page.locator('.ws-stage-band .ws-band-head')
      assert.equal(title.length, 90)
      assert.equal(await header.locator('h1').getAttribute('title'), title)
      if (device === 'desktop') {
        const geometry = await header.evaluate(el => {
          const box = el.getBoundingClientRect()
          return { barHeight: box.height, left: box.left, right: box.right }
        })
        assert.ok(geometry.barHeight <= 96, JSON.stringify(geometry))
        assert.ok(geometry.left >= 0 && geometry.right <= viewport.width, JSON.stringify(geometry))
      } else {
        const dock = await band(page).locator('.ws-dock').boundingBox()
        assert.ok(dock.x >= 0 && dock.x + dock.width <= viewport.width, JSON.stringify(dock))
      }
      // The root's row draws its acts on one stroke grid, on the row's centre line:
      // the verb button's face and caret, then the session pair at one size.
      const strip = acts(page)
      const icons = strip.locator(':is(button, a):has(> svg):visible')
      // The face, the caret and settings everywhere; the console beside them where this device has a route to the conversation (the harness's desktop, not its phone).
      assert.equal(await icons.count(), device === 'desktop' ? 4 : 3)
      const size = device === 'desktop' ? 15 : 20
      for (const icon of await icons.all()) {
        const label = await icon.getAttribute('aria-label')
        const caret = await icon.evaluate(el => el.matches('.ws-verb-more'))
        // The caret's tooltip lists the verbs it holds; every other act's tooltip is its name.
        if (!caret) assert.equal(await icon.getAttribute('title'), label)
        const mark = await icon.evaluate(el => {
          const svg = el.querySelector('svg'), box = svg.getBoundingClientRect(), css = getComputedStyle(svg)
          return { viewBox: svg.getAttribute('viewBox'), inheritsColor: css.stroke === css.color, width: box.width, height: box.height, weight: css.strokeWidth, session: el.matches('.ws-header-icon') }
        })
        const { viewBox, inheritsColor, weight } = mark
        assert.deepEqual({ viewBox, inheritsColor, weight }, { viewBox: '0 0 16 16', inheritsColor: true, weight: '1.5px' }, `${label} uses the same currentColor stroke grid in ${scheme}`)
        if (mark.session) assert.deepEqual([mark.width, mark.height], [size, size], `${label} draws at the session pair's size`)
        else assert.ok(mark.width === mark.height && mark.width <= size, `${label}'s mark is square and no larger than the pair's: ${mark.width}`)
        await icon.focus(); assert.equal(await icon.evaluate(el => el === document.activeElement), true)
      }
      const centres = await icons.evaluateAll(els => els.map(el => { const r = el.querySelector('svg').getBoundingClientRect(); return r.top + r.height / 2 }))
      assert.ok(Math.max(...centres) - Math.min(...centres) < 1, `the acts share one vertical centre in ${device}/${scheme}: ${centres}`)
      if (process.env.WORKSPACE_SHOTS) {
        await mkdir(process.env.WORKSPACE_SHOTS, { recursive: true })
        await page.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, `header-${device}-${scheme}.png`) })
      }
      const settings = strip.locator('.ws-acts-settings')
      await settings.click()
      const sheet = page.getByRole('dialog', { name: 'Settings', exact: true })
      await sheet.waitFor()
      assert.ok(await sheet.locator('.kbn-ctl-history').count())
      assert.equal(await sheet.locator('.ws-band-open').count(), 0, 'the way to the conversation stays outside Settings')
      await page.keyboard.press('Escape')
      await sheet.waitFor({ state: 'hidden' })
      assert.equal(await settings.evaluate(el => el === document.activeElement), true)
      if (device === 'desktop') {
        assert.ok(await page.locator('.ws-page.ws-selected .ov-head [data-part="sends"]').isVisible(), 'its sent files stand among its pages')
      } else {
        const files = await sentFiles(page)
        assert.ok(await files.locator('time').count(), 'sent files carry timestamps')
        await page.keyboard.press('Escape')
        await page.locator('.kbn-conversation-menu:has(.uf-file-row)').waitFor({ state: 'detached' })
      }
      // A verdict leaves settings before opening its undo window.
      await settings.click()
      await verbFace(strip).click()
      assert.equal(await page.locator('.ws-settings-menu:not([hidden])').count(), 0)
      const undo = strip.getByRole('button', { name: `Undo verdict on ${title}`, exact: true })
      await undo.waitFor(); await undo.click()
      assert.equal(await strip.locator('.ws-verdict-undo').count(), 0)
      assert.equal(await page.evaluate(() => window.__harness.requests.filter(r => r.method === 'POST' && r.url.includes('/transition')).length), 0)
    }, viewport)
  }
  test("The view's ⚙ opens Settings under it, clear of the console", async page => {
    await page.goto(url)
    await openRoot(page)
    const menu = page.locator('.ws-settings-menu:not([hidden])')
    const root = acts(page).locator('.ws-acts-settings')
    await root.click(); await menu.waitFor()
    const [box, anchor] = await Promise.all([menu.boundingBox(), root.boundingBox()])
    const below = Math.abs(box.y - (anchor.y + anchor.height)) <= 8, above = Math.abs(box.y + box.height - anchor.y) <= 8
    assert.ok(below || above, `the menu opens against its ⚙: ${JSON.stringify({ box, anchor })}`)
    const console = await band(page).locator('.ws-dock').boundingBox()
    assert.ok(box.y + box.height <= console.y + 0.5, 'Settings opened in the head keeps the console clear')
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })
    assert.equal(await root.evaluate(el => el === document.activeElement), true)
  }, { width: 1440, height: 900 })
}
