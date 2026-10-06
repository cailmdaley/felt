/** Run after npm run harness:board. CHROME_PATH selects Chromium. */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

// One worker pill on every surface: lowercase, untracked, unplated type that
// never changes with the state; only the dot's pigment says which state it is.
const TYPOGRAPHY = ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'textTransform', 'backgroundColor']
const VARIANTS = ['aloft', 'waiting', 'attention', 'blocked']

/** Every state of one pill shares its typography; returns the dot pigment per state. */
function parity(pill, [typography, variants]) {
  const original = { className: pill.className, state: pill.dataset.workerState }
  const read = () => Object.fromEntries(typography.map(property => [property, getComputedStyle(pill)[property]]))
  pill.dataset.workerState = 'aloft'
  const baseline = read()
  if (baseline.textTransform !== 'none' || (baseline.letterSpacing !== 'normal' && parseFloat(baseline.letterSpacing) !== 0)) throw new Error(`the pill is lowercase and untracked: ${JSON.stringify(baseline)}`)
  if (baseline.backgroundColor !== 'rgba(0, 0, 0, 0)') throw new Error(`the pill has no plate at rest: ${baseline.backgroundColor}`)
  const dots = {}
  for (const variant of variants) {
    pill.className = `${original.className.replace(/\bkbn-card-worker-\w+/g, '')} kbn-card-worker-${variant}`
    pill.dataset.workerState = variant
    const style = read()
    for (const property of typography) {
      if (style[property] !== baseline[property]) throw new Error(`${variant} ${property}: expected aloft's ${baseline[property]}, got ${style[property]}`)
    }
    dots[variant] = getComputedStyle(pill.querySelector('.ws-worker-dot')).backgroundColor
  }
  pill.className = original.className
  pill.dataset.workerState = original.state
  return dots
}
const runParity = (pill, args) => new Function(`return (${args.parity})`)()(pill, [args.typography, args.variants])
const parityArgs = { parity: parity.toString(), typography: TYPOGRAPHY, variants: VARIANTS }
const faces = pill => [pill.querySelector('.ws-worker-state'), pill.querySelector('.ws-worker-elapsed')].map(el => getComputedStyle(el).fontFamily)

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  for (const mobile of [false, true]) {
    const page = await browser.newPage({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1200, height: 900 },
      isMobile: mobile,
      hasTouch: mobile,
      userAgent: mobile
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
        : undefined,
      reducedMotion: 'reduce',
    })
    const harness = pathToFileURL(resolve('harness-board-dist/index.html')).href
    await page.goto(harness)
    const appCard = page.locator('.kbn-card').filter({ has: page.getByText('App conversation continuity', { exact: true }) })
    const appMark = appCard.locator('.kbn-card-worker')
    assert.equal(await appMark.locator('.ws-worker-state').textContent(), 'aloft')
    assert.ok(await appMark.isVisible())
    const destination = mobile ? 'chatgpt://' : 'codex://threads/01a0be38-6c36-7cd1-aec9-53a680d1f693'
    assert.equal(await appMark.getAttribute('href'), destination)
    // The app anchor, a terminal button and the worker-less phase badges share the pill's type.
    await appMark.evaluate((anchor, typography) => {
      const button = document.createElement('button')
      button.className = 'kbn-card-worker kbn-card-worker-aloft'
      button.innerHTML = anchor.innerHTML
      anchor.after(button)
      const app = getComputedStyle(anchor), terminal = getComputedStyle(button)
      for (const property of typography) {
        if (app[property] !== terminal[property]) throw new Error(`terminal ${property} ${terminal[property]} differs from app ${app[property]}`)
      }
      for (const variant of ['waiting', 'attention', 'blocked']) {
        const badge = document.createElement('span')
        badge.className = `kbn-card-phase kbn-card-phase-${variant}`
        anchor.after(badge)
        for (const property of typography) {
          if (getComputedStyle(badge)[property] !== app[property]) throw new Error(`${variant}: phase badge ${property} differs from the pill`)
        }
        badge.remove()
      }
      button.remove()
    }, TYPOGRAPHY)
    const deskDots = await appMark.evaluate(runParity, parityArgs)
    assert.equal(new Set(Object.values(deskDots)).size, 3, `aloft, waiting and attention each have their own dot: ${JSON.stringify(deskDots)}`)
    assert.equal(deskDots.attention, deskDots.blocked, "blocked wears attention's pigment")
    const deskFaces = await appMark.evaluate(faces)

    // The reader's head draws the same pill at its own scale; the fiber page draws none.
    await appCard.locator('.kbn-card-name').click()
    const head = page.locator('.ws-navbar .ws-head-worker .kbn-card-worker')
    await head.waitFor({ state: 'attached' })
    assert.equal(await head.getAttribute('href'), destination)
    assert.equal(await page.locator('.ws-selected .ws-dock .kbn-card-worker').count(), 0)
    await head.evaluate(runParity, parityArgs)
    if (mobile) {
      const box = await head.boundingBox()
      assert.ok(box.width >= 44 && box.height >= 44, `the phone's worker dot is a full target: ${JSON.stringify(box)}`)
    } else {
      assert.deepEqual(await head.evaluate(faces), deskFaces, 'the head and the card set word and age alike')
    }
    await page.close()
  }
  console.log('Worker pill parity passed on the Desk card and the reader head, desktop and phone')
} finally { await browser.close() }
