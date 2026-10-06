import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { findBrowser, sharedBrowser } from '../e2e/sharedBrowser.mjs'
import { getBrowser } from '../e2e/browser.mjs'

const fast = { readyMs: 300, pollMs: 5, probeMs: 50, graceMs: 60, killMs: 60, lockMs: 10_000 }
const temporary = () => mkdtempSync(join(tmpdir(), 'shared-browser-test-'))
const port = 9333, browserId = '/devtools/browser/0d1f'

// A process table and CDP endpoint that only exist in memory: every signal is recorded, none is sent.
function world({ processes = [], answers = 'ours', exitOn = 'SIGTERM' } = {}) {
  const stateDir = temporary()
  const signals = [], spawned = []
  let table = processes
  const fetch = async (url, { signal }) => {
    if (answers === 'nothing') throw new Error('ECONNREFUSED')
    if (answers === 'hang') return new Promise((_, fail) => signal.addEventListener('abort', () => fail(signal.reason)))
    const id = answers === 'foreign' ? '/devtools/browser/f0re' : browserId
    const body = url.endsWith('/json/version') ? { webSocketDebuggerUrl: `ws://127.0.0.1:${port}${id}` } : []
    return new Response(JSON.stringify(body))
  }
  const browser = sharedBrowser({
    port, stateDir, fetch, times: fast,
    processes: () => table.map(item => ({ ...item })),
    kill: (pid, signal) => {
      signals.push([pid, signal])
      if (signal === exitOn || signal === 'SIGKILL') table = table.filter(item => !(item.pid === pid || signal === 'SIGTERM' && item.ppid === pid))
    },
    spawn: async (path, args) => { spawned.push([path, args]) },
    locate: async () => '/fake/chrome',
  })
  writeFileSync(browser.logFile, `DevTools listening on ws://127.0.0.1:${port}${browserId}\n`)
  return {
    browser, signals, spawned,
    set table(next) { table = next },
    get table() { return table },
    cleanup: () => rmSync(stateDir, { recursive: true, force: true }),
  }
}

const chrome = (pid, ppid, args) => ({ pid, ppid, rssKiB: 1000, command: `/opt/chrome/chrome ${args}` })
const ours = profileDir => [
  chrome(202, 1, `--remote-debugging-port=${port} --headless=new --user-data-dir=${profileDir} --mute-audio`),
  chrome(203, 202, `--type=renderer --user-data-dir=${profileDir} --remote-debugging-port=${port}`),
  chrome(204, 202, `--type=gpu-process --user-data-dir=${profileDir}`),
]
const strangers = profileDir => [
  chrome(101, 1, `--remote-debugging-port=${port}0 --user-data-dir=/tmp/other`),
  chrome(102, 1, `--remote-debugging-port=${port} --user-data-dir=/home/someone/real-profile`),
  chrome(103, 1, `--remote-debugging-port=${port} --user-data-dir=${profileDir}0`),
  chrome(104, 103, `--type=renderer --user-data-dir=${profileDir}-old`),
]

describe('ownership: only the exact profile argument marks a process as ours', () => {
  for (const order of ['strangers first', 'ours first']) {
    it(`stop signals only the owned browser, with ${order}`, async () => {
      const w = world()
      const mine = ours(w.browser.profileDir)
      w.table = order === 'ours first' ? [...mine, ...strangers(w.browser.profileDir)] : [...strangers(w.browser.profileDir), ...mine]
      expect(await w.browser.stop()).toBe(true)
      expect(w.signals).toEqual([[202, 'SIGTERM']])
      expect(w.table.map(item => item.pid)).toEqual([101, 102, 103, 104])
      w.cleanup()
    })
  }

  it('leaves every stranger alone when the owned browser is not running', async () => {
    const w = world({ answers: 'nothing' })
    w.table = strangers(w.browser.profileDir)
    expect(await w.browser.stop()).toBe(false)
    expect(await w.browser.reap(0)).toEqual({ result: 'not running' })
    expect((await w.browser.status()).state).toBe('stopped')
    expect(w.signals).toEqual([])
    w.cleanup()
  })

  it('refuses a port another browser serves, without signalling or launching', async () => {
    const w = world({ answers: 'foreign' })
    w.table = strangers(w.browser.profileDir)
    await expect(w.browser.endpoint()).rejects.toThrow(/did not start/)
    expect(w.signals).toEqual([])
    expect(w.spawned).toEqual([])
    w.cleanup()
  })

  it('launches with the mock keychain, basic password store and muted audio', async () => {
    const w = world({ answers: 'nothing' })
    await expect(w.browser.endpoint()).rejects.toThrow(/exited/)
    expect(w.spawned).toHaveLength(1)
    expect(w.spawned[0][1]).toEqual(expect.arrayContaining(['--use-mock-keychain', '--password-store=basic', '--mute-audio', `--user-data-dir=${w.browser.profileDir}`]))
    w.cleanup()
  })
})

describe('health: an endpoint that does not answer never causes a kill', () => {
  it('a live browser whose probe times out is reported, not killed', async () => {
    const w = world({ answers: 'hang' })
    w.table = ours(w.browser.profileDir)
    await expect(w.browser.endpoint()).rejects.toThrow(/pid 202 is running but .* does not answer/)
    expect((await w.browser.status()).state).toBe('unresponsive')
    expect(await w.browser.reap(0)).toEqual({ result: 'unresponsive', pid: 202 })
    expect(w.signals).toEqual([])
    expect(w.spawned).toEqual([])
    w.cleanup()
  })

  it('a healthy owned browser hands out its endpoint', async () => {
    const w = world()
    w.table = ours(w.browser.profileDir)
    expect(await w.browser.endpoint()).toBe(`ws://127.0.0.1:${port}${browserId}`)
    expect((await w.browser.status()).state).toBe('running')
    w.cleanup()
  })

  it('helpers whose browser process died are still found, reported and reaped', async () => {
    const w = world({ answers: 'nothing' })
    w.table = ours(w.browser.profileDir).slice(1).map(item => ({ ...item, ppid: 1 }))
    expect((await w.browser.status())).toMatchObject({ state: 'orphaned', processCount: 2 })
    expect(await w.browser.reap(30)).toEqual({ result: 'reaped', pid: null })
    expect(w.signals).toEqual([[203, 'SIGTERM'], [204, 'SIGTERM']])
    expect(w.table).toEqual([])
    w.cleanup()
  })

  it('a pid reused by a stranger during shutdown is not signalled again', async () => {
    const w = world({ exitOn: 'none' })
    const mine = ours(w.browser.profileDir)
    w.table = mine
    const kill = w.signals.push.bind(w.signals)
    w.signals.push = entry => {
      // Chrome's root exits on SIGTERM, a stranger takes its pid, and one helper hangs on.
      if (entry[1] === 'SIGTERM') w.table = [chrome(202, 1, '--user-data-dir=/home/someone/real-profile'), mine[2]]
      if (entry[1] === 'SIGKILL') w.table = w.table.filter(item => item.pid !== entry[0])
      return kill(entry)
    }
    expect(await w.browser.stop()).toBe(true)
    expect([...w.signals]).toEqual([[202, 'SIGTERM'], [204, 'SIGKILL']])
    expect(w.table.map(item => item.pid)).toEqual([202])
    w.cleanup()
  })
})

describe('lock: contenders never overlap, and a crashed holder releases it', () => {
  const contender = (stateDir, id, holdMs) => spawn(process.execPath, ['--input-type=module', '-e', `
    import { appendFileSync } from 'node:fs'
    import { sharedBrowser } from ${JSON.stringify(resolve('e2e/sharedBrowser.mjs'))}
    const log = ${JSON.stringify(join(stateDir, 'critical.log'))}
    process.stdin.once('data', () => sharedBrowser({ stateDir: ${JSON.stringify(stateDir)}, port: ${port} }).withLock(async () => {
      appendFileSync(log, 'enter ${id} ' + Date.now() + '\\n')
      process.stdout.write('in\\n')
      await new Promise(done => setTimeout(done, ${holdMs}))
      appendFileSync(log, 'exit ${id}\\n')
    }).then(() => process.exit(0)))
  `], { stdio: ['pipe', 'pipe', 'inherit'] })

  it('serialises contenders released together, including one killed inside the section', async () => {
    const stateDir = temporary()
    const crasher = contender(stateDir, 'crash', 60_000)
    crasher.stdin.write('go\n')
    await new Promise(done => crasher.stdout.once('data', done))
    const others = Array.from({ length: 5 }, (_, index) => contender(stateDir, `c${index}`, 40))
    await new Promise(done => setTimeout(done, 300)) // let every contender reach the lock and wait on it
    for (const child of others) child.stdin.write('go\n')
    await new Promise(done => setTimeout(done, 300))
    const killedAt = Date.now()
    crasher.kill('SIGKILL')
    await Promise.all(others.map(child => new Promise(done => child.once('exit', done))))

    const lines = readFileSync(join(stateDir, 'critical.log'), 'utf8').trim().split('\n').map(line => line.split(' '))
    expect(lines[0].slice(0, 2)).toEqual(['enter', 'crash'])
    const rest = lines.slice(1)
    expect(rest).toHaveLength(10)
    for (let index = 0; index < rest.length; index += 2) {
      expect(rest[index][0]).toBe('enter')
      expect(Number(rest[index][2])).toBeGreaterThanOrEqual(killedAt)
      expect(rest[index + 1]).toEqual(['exit', rest[index][1]])
    }
    rmSync(stateDir, { recursive: true, force: true })
  }, 30_000)
})

describe('browser discovery', () => {
  const install = path => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '#!/bin/sh\n'); chmodSync(path, 0o755) }
  const revision = 'chromium-1234/chrome-linux64/chrome'
  // Platform win32 has no fixed install locations, so nothing outside the temporary caches can answer.
  const isolated = { platform: 'win32', playwrightPath: async () => revision }

  it('finds a Playwright-only install under PLAYWRIGHT_BROWSERS_PATH', async () => {
    const cache = temporary(), home = temporary()
    install(join(cache, revision))
    expect(await findBrowser({ ...isolated, env: { PLAYWRIGHT_BROWSERS_PATH: cache, PATH: '' }, home })).toBe(join(cache, revision))
  })

  it('finds a Playwright-only install in the default cache', async () => {
    const home = temporary()
    install(join(home, '.cache', 'ms-playwright', revision))
    expect(await findBrowser({ ...isolated, env: { PATH: '' }, home })).toBe(join(home, '.cache', 'ms-playwright', revision))
  })

  it('takes the revision path from the installed playwright-core package', async () => {
    const cache = temporary(), home = temporary()
    const { chromium } = await import('playwright-core')
    const relative = chromium.executablePath().match(/[\\/](chromium-\d+[\\/].+)$/)[1]
    install(join(cache, relative))
    expect(await findBrowser({ platform: 'win32', env: { PLAYWRIGHT_BROWSERS_PATH: cache, PATH: '' }, home })).toBe(join(cache, relative))
  })

  it('does not use a headless-shell-only install', async () => {
    const cache = temporary(), home = temporary()
    install(join(cache, 'chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell'))
    await expect(findBrowser({ ...isolated, env: { PLAYWRIGHT_BROWSERS_PATH: cache, PATH: '' }, home })).rejects.toThrow(/No Chrome/)
  })

  it('finds Puppeteer Chrome for Testing first', async () => {
    const home = temporary()
    install(join(home, '.cache', 'puppeteer', 'chrome', 'linux-154.0.1', 'chrome-linux64', 'chrome'))
    install(join(home, '.cache', 'ms-playwright', revision))
    expect(await findBrowser({ ...isolated, platform: 'linux', env: { PATH: '' }, home }))
      .toBe(join(home, '.cache', 'puppeteer', 'chrome', 'linux-154.0.1', 'chrome-linux64', 'chrome'))
  })
})

// A real browser on a temporary port and profile; skipped where no Chrome is installed.
const executablePath = await findBrowser().catch(() => null)
describe.skipIf(!executablePath)('media preferences hold from the first script, locally and shared', () => {
  const stateDir = temporary()
  let real, idle
  beforeAll(async () => {
    const free = () => new Promise(done => { const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => done(port)) }) })
    real = sharedBrowser({ port: await free(), stateDir })
    idle = sharedBrowser({ port: await free(), stateDir })
    await real.endpoint()
  }, 60_000)
  afterAll(async () => {
    await real?.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }, 30_000)

  const page = `<script>window.first = [matchMedia('(prefers-color-scheme: dark)').matches, matchMedia('(prefers-reduced-motion: reduce)').matches,
    matchMedia('(forced-colors: active)').matches, matchMedia('(prefers-contrast: more)').matches]</script>
    <a id="same" href="/next">same tab</a><a id="popup" href="/popup" target="_blank">popup</a>`
  const preferences = {
    dark: { colorScheme: 'dark', reducedMotion: 'reduce', forcedColors: 'active', contrast: 'more' },
    light: { colorScheme: 'light', reducedMotion: 'no-preference', forcedColors: 'none', contrast: 'no-preference' },
  }

  async function observe(session, options) {
    const context = await session.newContext(options)
    await context.route('http://probe.test/**', route => route.fulfill({ contentType: 'text/html', body: page }))
    const tab = await context.newPage()
    const first = () => tab.evaluate(() => window.first)
    const seen = {}
    await tab.setContent(page); seen.setContent = await first()
    await tab.goto('http://probe.test/'); seen.goto = await first()
    await tab.reload(); seen.reload = await first()
    await Promise.all([tab.waitForURL('**/next'), tab.click('#same')]); seen.link = await first()
    const [popup] = await Promise.all([tab.waitForEvent('popup'), tab.click('#popup')])
    await popup.waitForLoadState(); seen.popup = await popup.evaluate(() => window.first)
    return seen
  }

  for (const mode of ['local', 'shared']) {
    it(`${mode}: simultaneous contexts keep opposite preferences on every navigation path`, async () => {
      vi.stubEnv('SHARED_BROWSER', '')
      const session = await getBrowser({ executablePath, sharedBrowser: mode === 'shared' ? real : idle })
      try {
        expect(session.shared).toBe(mode === 'shared')
        const [dark, light] = await Promise.all([observe(session, preferences.dark), observe(session, preferences.light)])
        for (const path of ['setContent', 'goto', 'reload', 'link', 'popup']) {
          expect([path, dark[path]]).toEqual([path, [true, true, true, true]])
          expect([path, light[path]]).toEqual([path, [false, false, false, false]])
        }
      } finally {
        await session.close()
        vi.unstubAllEnvs()
      }
    }, 60_000)
  }
})
