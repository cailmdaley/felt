import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { sharedBrowser as defaultSharedBrowser } from './sharedBrowser.mjs'

export async function sharedBrowserAvailable(sharedBrowser = defaultSharedBrowser()) {
  return process.env.SHARED_BROWSER === '1' || (await sharedBrowser.status()).running
}

// Ignore contextless root targets by detaching this connection's session only.
// https://github.com/microsoft/playwright/commit/0726df3130b0972faa267c0fb38df904a39150ef
export function sharedCDPTransport(endpoint, Socket = globalThis.WebSocket) {
  const socket = new Socket(endpoint), pending = []
  let detachId = 0, failure, closed = false, closeReason, onclose
  const transport = {
    set onclose(listener) {
      onclose = listener
      if (closed) queueMicrotask(() => onclose?.(closeReason))
    },
    send(message) {
      if (closed) return
      const text = JSON.stringify(message)
      if (socket.readyState === 0) pending.push(text)
      else socket.send(text)
    },
    close() { socket.close() },
  }
  socket.addEventListener('open', () => { for (const text of pending.splice(0)) socket.send(text) })
  socket.addEventListener('error', event => { failure = event.message || 'CDP WebSocket failed' })
  socket.addEventListener('close', event => {
    closed = true; closeReason = failure || event.reason
    onclose?.(closeReason)
  })
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    // Playwright uses positive request ids; negative ids belong to our detach requests.
    if (message.id < 0) return
    const attached = message.method === 'Target.attachedToTarget' && !message.sessionId ? message.params : null
    if (attached && attached.targetInfo.type !== 'browser' && !attached.targetInfo.browserContextId
      && typeof attached.sessionId === 'string') {
      transport.send({ id: --detachId, method: 'Target.detachFromTarget', params: { sessionId: attached.sessionId } })
      return
    }
    transport.onmessage?.(message)
  })
  return transport
}

// Connects to the shared browser when SHARED_BROWSER=1 or it is already running; otherwise launches a local one.
export async function getBrowser({ args = [], executablePath, sharedBrowser = defaultSharedBrowser() } = {}) {
  const shared = await sharedBrowserAvailable(sharedBrowser)
  const browser = shared
    ? await chromium.connectOverCDP(sharedCDPTransport(await sharedBrowser.endpoint()), { noDefaults: true })
    : await launchLocalBrowser(args, executablePath)
  // CDP also attaches other clients' pages. Their owner handles dialogs;
  // Playwright's automatic dismissal would race that owner's response.
  if (shared) for (const context of browser.contexts()) context.on('dialog', () => {})
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
