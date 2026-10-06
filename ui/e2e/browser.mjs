import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const sharedBrowserScript = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/shared-browser')
const port = Number(process.env.SHARED_BROWSER_PORT || 9333)

async function sharedBrowserIsRunning() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })
    if (!response.ok) return false
    const version = await response.json()
    return typeof version.webSocketDebuggerUrl === 'string'
  } catch {
    return false
  }
}

function sharedBrowserEndpoint() {
  const result = spawnSync(process.execPath, [sharedBrowserScript, 'endpoint'], {
    encoding: 'utf8',
    env: process.env,
    timeout: 35_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Could not start the shared browser')
  const endpoint = result.stdout.trim()
  if (!endpoint.startsWith('ws://127.0.0.1:')) throw new Error(`Invalid shared browser endpoint: ${endpoint}`)
  return endpoint
}

export function sharedBrowserAvailable() {
  if (process.env.SHARED_BROWSER === '1') return true
  const result = spawnSync(process.execPath, [sharedBrowserScript, 'status', '--json'], {
    encoding: 'utf8',
    env: process.env,
    timeout: 2_000,
  })
  if (result.error || result.status !== 0) return false
  try {
    return JSON.parse(result.stdout).running === true
  } catch {
    return false
  }
}

export async function getBrowser({ args = [], executablePath } = {}) {
  const shared = process.env.SHARED_BROWSER === '1' || await sharedBrowserIsRunning()
  const browser = shared
    ? await chromium.connectOverCDP(sharedBrowserEndpoint())
    : await launchLocalBrowser(args, executablePath)
  const contexts = new Set()
  let closed = false

  async function newContext(options) {
    if (closed) throw new Error('This browser session is already closed')
    // Set CDP media emulation after commit, before page scripts, so parallel clients keep separate preferences.
    const mediaOptions = Object.fromEntries(['colorScheme', 'reducedMotion', 'forcedColors', 'contrast']
      .filter(name => options?.[name] !== undefined).map(name => [name, options[name]]))
    const contextOptions = shared && Object.keys(mediaOptions).length ? { ...options } : options
    if (shared && contextOptions) for (const name of Object.keys(mediaOptions)) delete contextOptions[name]
    const context = await browser.newContext(contextOptions)
    contexts.add(context)
    context.once('close', () => contexts.delete(context))
    if (shared && Object.keys(mediaOptions).length) {
      const newPage = context.newPage.bind(context)
      context.newPage = async (...args) => {
        const page = await newPage(...args)
        for (const method of ['goto', 'reload', 'goBack', 'goForward']) {
          const navigate = page[method].bind(page)
          const optionsIndex = method === 'goto' ? 1 : 0
          page[method] = async (...navigationArgs) => {
            const { waitUntil = 'load', ...waitOptions } = navigationArgs[optionsIndex] ?? {}
            navigationArgs[optionsIndex] = { ...waitOptions, waitUntil: 'commit' }
            const response = await navigate(...navigationArgs)
            await page.emulateMedia(mediaOptions)
            if (waitUntil !== 'commit') await page.waitForLoadState(waitUntil, waitOptions)
            return response
          }
        }
        return page
      }
    }
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
