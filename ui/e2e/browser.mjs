import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { sharedBrowser as defaultSharedBrowser } from './sharedBrowser.mjs'

export async function sharedBrowserAvailable(sharedBrowser = defaultSharedBrowser()) {
  return process.env.SHARED_BROWSER === '1' || (await sharedBrowser.status()).running
}

// Connects to the shared browser when SHARED_BROWSER=1 or it is already running; otherwise launches a local one.
export async function getBrowser({ args = [], executablePath, sharedBrowser = defaultSharedBrowser() } = {}) {
  const shared = await sharedBrowserAvailable(sharedBrowser)
  const browser = shared
    ? await chromium.connectOverCDP(await sharedBrowser.endpoint())
    : await launchLocalBrowser(args, executablePath)
  const contexts = new Set()
  let closed = false

  async function newContext(options) {
    if (closed) throw new Error('This browser session is already closed')
    const context = await browser.newContext(options)
    contexts.add(context)
    context.once('close', () => contexts.delete(context))
    return context
  }

  return {
    shared,
    isConnected: () => browser.isConnected(),
    newContext,
    async newPage(options) {
      return (await newContext(options)).newPage()
    },
    async close() {
      if (closed) return
      closed = true
      await Promise.all([...contexts].map(context => context.close().catch(() => {})))
      // Closing a CDP-attached Playwright browser disconnects this client; Chrome stays running.
      await browser.close()
    },
  }
}

async function launchLocalBrowser(args, executablePath) {
  if (executablePath && !existsSync(executablePath)) throw new Error(`Chrome not found at ${executablePath}; set CHROME_PATH`)
  return chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true, args: [...new Set(['--mute-audio', ...args])] })
}
