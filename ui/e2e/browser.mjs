import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { findBrowser } from './sharedBrowser.mjs'

const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//
const fontCache = join(import.meta.dirname, '..', 'node_modules', '.cache', 'e2e-fonts')

/**
 * A headless Chrome of the check's own. A browser shared with other lanes
 * serialises their work behind ours and skews every timing we measure.
 *
 * Sandboxed report frames stay in the page's process: an out-of-process frame
 * receives input by the compositor's last hit-test map, so a click on a sheet
 * that opened over a frame in the same moment can land in the frame instead.
 *
 * Every context serves the board's Google Fonts from a disk cache filled on
 * first use, so a page's load never waits on the network and every journey
 * lays out in the same faces.
 */
export async function launchBrowser({ args = [] } = {}) {
  const browser = await chromium.launch({
    executablePath: await findBrowser(),
    headless: true,
    args: [...new Set([
      '--mute-audio', '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required',
      '--disable-features=IsolateSandboxedIframes', ...args,
    ])],
  })
  const newContext = browser.newContext.bind(browser)
  browser.newContext = async options => {
    const context = await newContext(options)
    await context.route(FONTS, cachedFont)
    return context
  }
  return browser
}

async function cachedFont(route) {
  const file = join(fontCache, createHash('sha256').update(route.request().url()).digest('hex'))
  try {
    const cached = await readFile(`${file}.type`, 'utf8').then(async contentType => ({ contentType, body: await readFile(file) }), () => null)
    if (cached) return await route.fulfill({ ...cached, headers: { 'access-control-allow-origin': '*' } })
    const response = await route.fetch()
    if (response.ok()) {
      // The body lands before its type, each by rename, so a reader never sees a partial font.
      await mkdir(fontCache, { recursive: true })
      const partial = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`
      await writeFile(partial, await response.body()); await rename(partial, file)
      await writeFile(partial, response.headers()['content-type'] ?? 'application/octet-stream'); await rename(partial, `${file}.type`)
    }
    await route.fulfill({ response })
  } catch {
    // Offline, or the journey's context closed mid-fetch: the page keeps its fallback face.
    await route.abort().catch(() => {})
  }
}
