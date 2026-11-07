import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getBrowser } from './browser.mjs'
import { familyTree, openThread, sentFiles } from './familyNav.mjs'

const title = 'Calibrate the shear response across independent sky patches and validate each redshift bin'
const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=threads&long-title`
const named = (page, name) => page.waitForFunction(name => document.querySelector('.ws-stage-band .ws-band-title')?.textContent === name, name)
async function openRoot(page) {
  // Click the row's own name: its crumb leads to the root.
  const name = page.locator('.kbn-desk .kbn-card').filter({ hasText: title }).first().locator('.kbn-card-name')
  const box = await name.boundingBox()
  await name.click({ position: { x: box.width - 6, y: box.height / 2 } })
  const header = page.locator('.ws-stage-band .ws-band-head')
  await header.waitFor()
  // A family's Desk row opens its frontier; these journeys exercise the root.
  if (await header.locator('h1').textContent() !== title) {
    await header.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.locator('.ws-settings-menu:not([hidden]) .ws-ancestry-link').first().click()
  }
  await named(page, title)
}
const visibleHeaderVerbs = header => header.locator('.kbn-ctl-verdict button').evaluateAll(buttons =>
  buttons.filter(button => button.checkVisibility()).map(button => button.getAttribute('aria-label')))
/** The worker line's verbs under the band's head. */
const workerVerbs = page => page.locator('.ws-stage-band .ws-worker-acts button').evaluateAll(buttons =>
  buttons.filter(button => button.checkVisibility()).map(button => button.dataset.verb))
const assertLifecycleInk = async (header, scheme) => {
  const renderedTheme = await header.evaluate(el => ({
    appearance: document.documentElement.dataset.wsAppearance,
    pageTheme: el.closest('.ws-reader')?.dataset.wsThemeName,
  }))
  assert.equal(renderedTheme.appearance, scheme, `the document resolves to ${scheme}: ${JSON.stringify(renderedTheme)}`)
  assert.equal(renderedTheme.pageTheme, scheme === 'dark' ? 'night-chart' : 'portolan', `the selected page uses the ${scheme} bundled theme: ${JSON.stringify(renderedTheme)}`)
  const verbs = await header.locator('.kbn-ctl-verdict button').evaluateAll(buttons => buttons
    .filter(button => button.checkVisibility())
    .map(button => {
      const style = getComputedStyle(button)
      return {
        label: button.getAttribute('aria-label'),
        pigment: style.getPropertyValue('--verdict-pigment').trim(),
        color: style.color,
      }
    }))
  const neutral = await header.evaluate(el => {
    const sample = document.createElement('span')
    sample.style.cssText = 'position:fixed;left:-9999px;color:var(--ws-ink-muted)'
    el.append(sample)
    const color = getComputedStyle(sample).color
    sample.remove()
    return color
  })
  for (const verb of verbs) {
    if (['Temper', 'Discard'].includes(verb.label)) {
      assert.ok(verb.pigment, `${verb.label} carries verdict pigment`)
    } else {
      assert.equal(verb.pigment, '', `${verb.label} has no verdict pigment: ${JSON.stringify(verb)}`)
      assert.equal(verb.color, neutral, `${verb.label} uses the shared neutral ink: ${JSON.stringify(verb)}`)
    }
  }
}
async function captureMeetingState(page, scene, width, scheme) {
  if (!process.env.WORKSPACE_SHOTS) return
  const height = width < 500 ? 844 : 900
  await mkdir(process.env.WORKSPACE_SHOTS, { recursive: true })
  await page.waitForFunction(width => window.innerWidth === width, width)
  await page.mouse.move(width - 2, height - 2)
  await page.screenshot({
    path: resolve(process.env.WORKSPACE_SHOTS, `meeting-${scene}-${width}-${scheme}.png`),
    animations: 'disabled',
  })
}
export function registerHeaderBarJourneys(test) {
  test('Lifecycle state selects the header verbs; only verdicts carry pigment', async page => {
    await page.addInitScript(() => {
      if (window !== window.top) return
      const scheme = new URLSearchParams(location.search).get('e2e-appearance') || 'light'
      localStorage.setItem('shuttle.appearance', JSON.stringify({ mode: scheme, dark: 'night-chart' }))
    })
    for (const scheme of ['light', 'dark']) {
      await page.goto(`${url}&e2e-appearance=${scheme}`)
      await openRoot(page)
      const header = page.locator('.ws-stage-band .ws-band-head')
      assert.deepEqual(await visibleHeaderVerbs(header), ['Temper', 'Discard'], 'Awaiting review offers its verdicts')
      assert.deepEqual(await workerVerbs(page), ['Resume', 'New session'])
      await assertLifecycleInk(header, scheme)
      const visits = [
        ['Response analysis', ['Close for review', 'Rest'], ['Send', 'New session']],
        ['Draft the validation plan', ['Rest'], ['Start']],
        ['Next validation', [], ['Start']],
        ['Accepted pilot', [], ['Start']],
        ['Discarded pilot', [], ['Start']],
      ]
      for (const [name, verbs, worker] of visits) {
        const tree = await familyTree(page)
        await openThread(page, tree.locator('.kbn-thread-row').filter({ has: page.getByText(name, { exact: true }) }), name)
        assert.deepEqual(await visibleHeaderVerbs(header), verbs, `${name} draws only its state actions`)
        assert.deepEqual(await workerVerbs(page), worker, `${name} offers its worker's verbs`)
        await assertLifecycleInk(header, scheme)
      }
    }
  }, { width: 1000, height: 900 })
  test('Width changes keep visible focus on the band', async page => {
    await page.goto(url)
    await openRoot(page)
    const header = page.locator('.ws-stage-band .ws-band-head')
    const focused = locator => locator.evaluate(el => el === document.activeElement)
    for (const name of ['Settings', 'Temper', 'Constitution']) {
      const control = header.getByRole('button', { name, exact: true })
      await control.focus()
      for (const width of [850, 390, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        assert.ok(await focused(control), `${name} keeps focus at ${width}`)
      }
    }
  }, { width: 1440, height: 900 })
  test('The band title holds one line down to a 701px viewport, with the verbs its state selects', async page => {
    await page.goto(url)
    await openRoot(page)
    const header = page.locator('.ws-stage-band .ws-band-head')
    for (const width of [1440, 850, 701]) {
      await page.setViewportSize({ width, height: 900 })
      const geometry = await header.locator('h1').evaluate(el => ({ height: el.clientHeight, line: parseFloat(getComputedStyle(el).lineHeight), wrap: getComputedStyle(el).whiteSpace, overflow: getComputedStyle(el).textOverflow }))
      assert.deepEqual([geometry.wrap, geometry.overflow], ['nowrap', 'ellipsis'])
      assert.ok(geometry.height <= geometry.line + 1, JSON.stringify(geometry))
      assert.equal(await header.locator('h1').getAttribute('title'), title)
      assert.deepEqual(await visibleHeaderVerbs(header), ['Temper', 'Discard'], `Awaiting review draws only its verbs at ${width}`)
    }
  }, { width: 1440, height: 900 })
  test('The band keeps its title and every verb inside open desktop columns', async page => {
    await page.goto(url)
    await openRoot(page)
    const header = page.locator('.ws-stage-band .ws-band-head')
    let labelSize
    const check = async () => {
      const sizes = await header.locator('.ws-band-state, .kbn-ctl-verdict button:not([hidden]) .ws-header-word').evaluateAll(els => els.filter(el => el.checkVisibility()).map(el => parseFloat(getComputedStyle(el).fontSize)))
      labelSize ??= sizes[0]
      assert.ok(sizes.every(size => size === labelSize), `state and verbs retain the wide header text size: ${sizes}`)
      await page.waitForFunction(() => {
        const title = document.querySelector('.ws-stage-band .ws-band-title')
        const header = title?.closest('header'), box = header?.getBoundingClientRect()
        return title && box && title.clientWidth > 0 &&
          [...header.querySelectorAll('.kbn-ctl-verdict button')].filter(button => button.checkVisibility()).every(button => {
            const b = button.getBoundingClientRect()
            return b.left >= box.left && b.right <= box.right && b.top >= box.top && b.bottom <= box.bottom
          })
      })
      assert.ok(await header.locator('h1').evaluate(el => el.clientHeight <= parseFloat(getComputedStyle(el).lineHeight) + 1))
      for (const name of ['Temper', 'Discard']) {
        const verb = header.getByRole('button', { name, exact: true })
        assert.ok(await verb.isVisible())
        assert.ok(await verb.evaluate(el => {
          const b = el.getBoundingClientRect(), h = el.closest('header').getBoundingClientRect()
          return b.left >= h.left && b.right <= h.right && b.top >= h.top && b.bottom <= h.bottom
        }), `${name} fits inside the header`)
      }
    }
    for (const width of [1440, 850, 701, 1440]) {
      await page.setViewportSize({ width, height: 900 }); await check()
      if (process.env.WORKSPACE_SHOTS && width === 701) await page.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, 'header-narrow-desktop-light.png') })
    }
  }, { width: 1440, height: 900 })
  test('The 390px phone band is one row of verbs that slides sideways, leaving the name to the top bar', async page => {
    await page.addInitScript(() => {
      if (window !== window.top) return
      localStorage.setItem('shuttle.appearance', JSON.stringify({ mode: 'light' }))
    })
    await page.goto(url)
    await openRoot(page)
    const header = page.locator('.ws-stage-band .ws-band-head')
    const assertBand = async (expected, width = 390) => {
      assert.deepEqual(await visibleHeaderVerbs(header), expected)
      assert.equal(await header.locator('h1').isVisible(), false, 'the top bar names the page')
      const row = await header.boundingBox()
      assert.ok(row.x >= 0 && row.x + row.width <= width && row.height <= 64, `the band is one row inside the phone: ${JSON.stringify(row)}`)
      const centers = await header.locator('.ws-band-acts button:visible').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 }))
      assert.ok(centers.length >= 2 && Math.max(...centers) - Math.min(...centers) < 2, `the verbs share one row: ${centers}`)
      for (const name of [...expected, 'Settings']) {
        const control = header.getByRole('button', { name, exact: true })
        await control.scrollIntoViewIfNeeded()
        const box = await control.boundingBox()
        assert.ok(box.x >= 0 && box.x + box.width <= width + 1 && box.height >= 44, `${name} scrolls into reach: ${JSON.stringify(box)}`)
      }
      await header.evaluate(el => { el.scrollLeft = 0 })
    }
    await assertBand(['Temper', 'Discard'])
    await openThread(page, (await familyTree(page)).locator('.kbn-thread-row').filter({ hasText: 'Response analysis' }), 'Response analysis')
    await assertBand(['Close for review', 'Rest'])
    const reviewInk = await header.getByRole('button', { name: 'Close for review', exact: true }).evaluate(el => {
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
    await (await familyTree(page)).locator('.kbn-thread-row').filter({ hasText: 'Next validation' }).click()
    await named(page, 'Next validation')
    await assertBand([])
    if (process.env.WORKSPACE_SHOTS) {
      await mkdir(process.env.WORKSPACE_SHOTS, { recursive: true })
      await page.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, 'resting-seat-phone-light.png') })
    }
  }, { width: 390, height: 844 })
  test('Listen stays one control inside the band at every width', async page => {
    await page.goto(url); await openRoot(page)
    const header = page.locator('.ws-stage-band .ws-band-head')
    for (const width of [1440, 1000, 701, 390, 320]) {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 900 })
      const arm = header.locator('.kbn-ctl-meet-arm')
      await arm.scrollIntoViewIfNeeded()
      const [band, control] = await Promise.all([header.boundingBox(), header.locator('.kbn-ctl-meet').boundingBox()])
      assert.ok(control.x >= band.x - 1 && control.x + control.width <= band.x + band.width + 1, `Listen sits inside the band at ${width}: ${JSON.stringify({ band, control })}`)
      assert.equal(await arm.getAttribute('aria-label'), 'Listen')
      if (process.env.WORKSPACE_SHOTS && [1440, 390, 320].includes(width)) {
        await mkdir(process.env.WORKSPACE_SHOTS, { recursive: true })
        await page.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, `meeting-band-control-${width}-light.png`) })
      }
      await header.evaluate(el => { el.scrollLeft = 0 })
    }
  }, { width: 1440, height: 900 })
  test('Listen reads the meeting that holds the mic, with Pause and Stop beside it', async page => {
    await page.goto(`${url}&meeting=joined`)
    await openRoot(page)
    const band = page.locator('.ws-stage-band')
    const chip = band.locator('.kbn-ctl-meet-arm')
    await chip.waitFor({ state: 'visible' })
    assert.match(await band.locator('.ws-voice-strip').innerText(), /^Meeting → /)
    assert.equal(await band.locator('.kbn-ctl-meet').count(), 1)
    assert.ok(await band.locator('.kbn-ctl-meet-stop').isVisible())
    await band.locator('.kbn-ctl-meet-dropdown').click()
    assert.ok(await page.getByRole('menuitem', { name: 'Open transcript', exact: true }).isEnabled())
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('.ws-stage-band .kbn-detail-transcript').count(), 0)
    await page.locator('.ws-band-leave').click()
    await page.locator('.kbn-desk .kbn-card').filter({ hasText: 'Remote covariance review' }).click()
    const foreign = page.locator('.ws-stage-band')
    assert.match(await foreign.locator('.ws-voice-strip').innerText(), /^Meeting → /)
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await captureMeetingState(page, 'single-recording-menu', width, 'light')
    }
    await foreign.locator('.kbn-ctl-meet-stop').click()
    await page.waitForFunction(() => window.__harness.requests.some(r => r.url?.includes('/meeting/stop')))
  }, { width: 1000, height: 900 })
  test('Listen turns following on, and Pause and Stop act on it', async page => {
    await page.goto(url)
    await openRoot(page)
    const band = page.locator('.ws-stage-band')
    const chip = band.locator('.kbn-ctl-meet-arm')
    await chip.waitFor({ state: 'visible' })
    assert.equal(await chip.innerText(), 'Listen')
    await chip.click()
    await page.waitForFunction(() => document.querySelector('.ws-stage-band .ws-voice-strip')?.textContent?.startsWith('Following → '))
    await band.locator('.kbn-ctl-meet-pause').click()
    await page.waitForFunction(() => document.querySelector('.ws-stage-band .kbn-ctl-meet-paused'))
    await band.locator('.kbn-ctl-meet-stop').click()
    await page.waitForFunction(() => document.querySelector('.ws-stage-band .kbn-ctl-meet-arm')?.textContent === 'Listen' && document.querySelector('.ws-stage-band .ws-voice-strip')?.hidden)
    const posts = await page.evaluate(() => window.__harness.requests.filter(r => r.method === 'POST' && r.url.endsWith('/api/v1/voice')).map(r => JSON.parse(r.body)))
    assert.deepEqual(posts, [{ enabled: true, muted: false }, { muted: true }, { enabled: false }])
  }, { width: 1000, height: 900 })
  test('× leaves the band for the Desk and writes nothing', async page => {
    await page.goto(url)
    await openRoot(page)
    const header = page.locator('.ws-stage-band .ws-band-head')
    await header.waitFor()
    const posts = () => page.evaluate(() => window.__harness.requests.filter(r => r.method !== 'GET').length)
    const before = await posts()
    await header.locator('.ws-band-leave').click()
    await page.locator('.kbn-desk .kbn-card[data-fiber-id="research/workspace/calibration-report"]').waitFor({ state: 'visible' })
    await page.locator('.ws-reader.ws-dormant').waitFor({ state: 'attached' })
    assert.equal(await posts(), before, '× sends no write')
  }, { width: 1440, height: 900 })
  test('Thread rows own Enter and Space while body focus keeps expand and paging shortcuts', async page => {
    await page.goto(url)
    await openRoot(page)
    const header = page.locator('.ws-stage-band .ws-band-head')
    const row = async name => (await familyTree(page)).locator('.kbn-thread-row').filter({ hasText: name })
    for (const key of ['Enter', 'Space']) {
      const press = async target => { await target.focus(); await page.keyboard.press(key) }
      await openThread(page, await row('Response analysis'), 'Response analysis', press)
      await openThread(page, await row(title), title, press)
    }
    await page.evaluate(() => { document.activeElement?.blur(); document.body.focus() })
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('.ws-reader').classList.contains('ws-expand-mode'))
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => !document.querySelector('.ws-reader').classList.contains('ws-expand-mode'))
    await page.setViewportSize({ width: 1440, height: 400 })
    await header.getByRole('button', { name: 'Constitution', exact: true }).click()
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
    for (const scheme of ['light', 'dark']) test(`The family tree keeps its root and marks the open thread (${device}, ${scheme})`, async page => {
      await page.addInitScript(scheme => {
        if (window !== window.top) return
        localStorage.setItem('shuttle.appearance', JSON.stringify({ mode: scheme, dark: 'night-chart' }))
      }, scheme)
      await page.goto(url)
      await openRoot(page)
      const header = page.locator('.ws-stage-band .ws-band-head')
      const family = page.locator('.ws-page.ws-selected .ws-family-all .ws-family')
      const show = () => familyTree(page)
      const rootAnchor = () => family.locator('.kbn-thread-row').first()
      for (const name of ['Response analysis', 'Choose the response cut']) {
        await show()
        await openThread(page, family.locator('.kbn-thread-row').filter({ hasText: name }), name)
        await show()
        assert.equal(await rootAnchor().count(), 1)
        assert.equal(await rootAnchor().locator('.kbn-thread-name').innerText(), title)
        assert.ok(await rootAnchor().locator('.constitution-state-dot').isVisible())
        if (process.env.WORKSPACE_SHOTS && name === 'Choose the response cut') {
          await mkdir(process.env.WORKSPACE_SHOTS, { recursive: true })
          await page.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, `family-${device}-${scheme}.png`) })
        }
        await openThread(page, rootAnchor(), title)
        await show()
        assert.equal(await rootAnchor().count(), 1)
        assert.equal(await rootAnchor().getAttribute('aria-current'), 'page')
      }
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
      const geometry = await header.evaluate(el => {
        const box = el.getBoundingClientRect()
        return { barHeight: box.height, left: box.left, right: box.right, wraps: el.scrollWidth > el.clientWidth }
      })
      assert.ok(geometry.barHeight <= (device === 'desktop' ? 96 : 64), JSON.stringify(geometry))
      assert.ok(geometry.left >= 0 && geometry.right <= viewport.width, JSON.stringify(geometry))
      assert.equal(await page.locator('.ws-report-inset, .ws-header-sheet').count(), 0)
      for (const label of device === 'desktop' ? ['Settings', 'Constitution', 'Temper', 'Discard'] : ['Settings', 'Constitution']) {
        const icon = header.getByRole('button', { name: label, exact: true })
        assert.equal(await icon.getAttribute('title'), label)
        assert.deepEqual(await icon.evaluate(el => {
          const svg = el.querySelector('svg'), box = svg?.getBoundingClientRect(), css = svg && getComputedStyle(svg)
          return { viewBox: svg?.getAttribute('viewBox'), inheritsColor: css?.stroke === getComputedStyle(el).color, width: box?.width, height: box?.height, weight: css?.strokeWidth }
        }), { viewBox: '0 0 16 16', inheritsColor: true, width: 16, height: 16, weight: '1.5px' }, `${label} uses the same currentColor stroke grid in ${scheme}`)
        await icon.focus(); assert.equal(await icon.evaluate(el => el === document.activeElement), true)
      }
      if (device === 'desktop') {
        const centers = await header.locator('.ws-band-acts .ws-header-icon:visible svg').evaluateAll(svgs => svgs.map(svg => svg.getBoundingClientRect()).filter(box => box.height).map(box => box.top + box.height / 2))
        assert.ok(centers.length >= 1 && Math.max(...centers) - Math.min(...centers) < 1, `lifecycle icons share one vertical center in ${device}/${scheme}: ${centers}`)
      }
      if (process.env.WORKSPACE_SHOTS) {
        await mkdir(process.env.WORKSPACE_SHOTS, { recursive: true })
        await page.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, `header-${device}-${scheme}.png`) })
      }
      await header.getByRole('button', { name: 'Settings', exact: true }).click()
      const sheet = page.getByRole('group', { name: 'Settings', exact: true })
      await sheet.waitFor()
      assert.ok(await sheet.locator('.kbn-ctl-history').count())
      assert.equal(await sheet.locator('.ws-band-open').count(), 0, 'the way to the conversation stays outside Settings')
      await page.keyboard.press('Escape')
      await sheet.waitFor({ state: 'hidden' })
      assert.equal(await header.getByRole('button', { name: 'Settings', exact: true }).evaluate(el => el === document.activeElement), true)
      const files = await sentFiles(page)
      assert.ok(await files.locator('time').count(), 'sent files carry timestamps')
      await page.keyboard.press('Escape')
      await page.locator('.ws-page-sheet[open]').waitFor({ state: 'hidden' })
      // A verdict leaves settings before opening its undo window.
      await header.getByRole('button', { name: 'Settings', exact: true }).click()
      await header.getByRole('button', { name: 'Temper', exact: true }).click()
      assert.equal(await page.locator('.ws-settings-menu:not([hidden])').count(), 0)
      const undo = header.getByRole('button', { name: `Undo verdict on ${title}`, exact: true })
      await undo.waitFor(); await undo.click()
      assert.equal(await header.locator('.ws-verdict-undo').count(), 0)
      assert.equal(await page.evaluate(() => window.__harness.requests.filter(r => r.method === 'POST' && r.url.includes('/transition')).length), 0)
    }, viewport)
  }
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const cases = []; registerHeaderBarJourneys((...args) => cases.push(args))
  const browser = await getBrowser({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--allow-file-access-from-files'] })
  try {
    for (const [name, run, viewport] of cases) {
      const context = await browser.newContext({ viewport, isMobile: viewport.width <= 700, hasTouch: viewport.width <= 700, reducedMotion: 'reduce' })
      try { await run(await context.newPage()); console.log(`PASS ${name}`) } finally { await context.close() }
    }
  } finally { await browser.close() }
}
