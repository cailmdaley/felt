// One long-lived headless Chrome that e2e runs and agent-browser lanes attach to over CDP.
//
// Ownership is the profile: every process of the owned browser, helpers included, carries the exact
// `--user-data-dir=<stateDir>/profile-<port>` argument, and nothing else on the machine does. No pid is
// ever persisted, so there is nothing to go stale or be reused. The endpoint is ours only when the
// browser id /json/version reports appears in the DevTools line our launch wrote to its log.
// Mutating commands hold an flock (through perl, which Node lacks), released by the OS when its holder dies.
import { spawn as spawnProcess, execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const sleep = ms => new Promise(done => setTimeout(done, ms))
const hasArg = (command, arg) => ` ${command} `.includes(` ${arg} `)

export const system = {
  processes() {
    const output = execFileSync('ps', ['-ww', '-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' })
    return output.split('\n').flatMap(line => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
      return match ? [{ pid: +match[1], ppid: +match[2], rssKiB: +match[3], command: match[4] }] : []
    })
  },
  kill(pid, signal) {
    try { process.kill(pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
  },
  async spawn(path, args, logFd) {
    const child = spawnProcess(path, args, { detached: true, stdio: ['ignore', 'ignore', logFd] })
    await new Promise((done, fail) => { child.once('spawn', done); child.once('error', fail) })
    child.unref()
  },
}

export const timing = { readyMs: 30_000, pollMs: 150, probeMs: 750, graceMs: 5_000, killMs: 2_000, lockMs: 45_000 }

export function sharedBrowser({
  env = process.env,
  port = Number(env.SHARED_BROWSER_PORT || 9333),
  stateDir = resolve(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'shared-browser'),
  processes = system.processes, kill = system.kill, spawn = system.spawn, fetch = globalThis.fetch,
  locate = () => findBrowser({ env }), times = timing,
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid SHARED_BROWSER_PORT: ${port}`)
  const profileDir = join(stateDir, `profile-${port}`)
  const logFile = join(stateDir, `browser-${port}.log`)
  const usedFile = join(stateDir, `browser-${port}.used`)
  const lockFile = join(stateDir, `browser-${port}.flock`)
  const profileArg = `--user-data-dir=${profileDir}`, portArg = `--remote-debugging-port=${port}`
  const args = [
    portArg, '--remote-debugging-address=127.0.0.1', '--remote-allow-origins=*', '--headless=new', profileArg,
    '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required',
    // Muted, and kept away from the login keychain and the system password store.
    '--mute-audio', '--use-mock-keychain', '--password-store=basic',
    '--no-first-run', '--no-default-browser-check', '--no-startup-window',
    '--disable-background-networking', '--disable-sync', '--disable-component-update',
    ...(typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : []),
  ]

  const owned = list => list.filter(item => hasArg(item.command, profileArg))
  const rootOf = list => owned(list).find(item => hasArg(item.command, portArg) && !/(?:^|\s)--type=/.test(item.command)) ?? null

  async function json(path) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(times.probeMs) })
      return response.ok ? await response.json() : null
    } catch {
      return null
    }
  }

  // null when nothing answers; otherwise whether the answering browser is the one our launch logged.
  async function probe() {
    const version = await json('/json/version')
    let id
    try { id = new URL(version.webSocketDebuggerUrl).pathname } catch { return null }
    const log = await readFile(logFile, 'utf8').catch(() => '')
    const ours = [...log.matchAll(/DevTools listening on (ws:\/\/\S+)/g)].some(([, url]) => new URL(url).pathname === id)
    return { ours, endpoint: `ws://127.0.0.1:${port}${id}` }
  }

  async function gone(ms) {
    const until = Date.now() + ms
    while (owned(processes()).length) {
      if (Date.now() >= until) return false
      await sleep(times.pollMs)
    }
    return true
  }

  // Each signal goes to a pid read from a fresh snapshot by its exact profile argument.
  async function terminate(list) {
    const targets = owned(list)
    if (!targets.length) return false
    const root = rootOf(list)
    for (const item of root ? [root] : targets) kill(item.pid, 'SIGTERM')
    if (await gone(times.graceMs)) return true
    for (const item of owned(processes())) kill(item.pid, 'SIGKILL')
    if (await gone(times.killMs)) return true
    throw new Error(`Could not stop shared browser processes ${owned(processes()).map(item => item.pid).join(', ')}`)
  }

  async function withLock(action) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    const holder = spawnProcess('perl', ['-MFcntl=:flock', '-e',
      'open(my $f, ">>", $ARGV[0]) or die "$ARGV[0]: $!\\n"; flock($f, LOCK_EX) or die "flock: $!\\n"; $| = 1; print "locked\\n"; 1 while <STDIN>',
      lockFile], { stdio: ['pipe', 'pipe', 'inherit'] })
    const exited = new Promise(done => holder.once('close', done))
    try {
      await new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`Timed out waiting for ${lockFile}`)), times.lockMs)
        holder.stdout.once('data', () => { clearTimeout(timer); done() })
        holder.once('error', error => { clearTimeout(timer); fail(error) })
        holder.once('close', code => { clearTimeout(timer); fail(new Error(`Could not lock ${lockFile} (perl exited ${code})`)) })
      })
      return await action()
    } finally {
      holder.stdin.end()
      await exited
    }
  }

  const touch = () => writeFile(usedFile, '', { mode: 0o600 })

  async function launch() {
    await mkdir(profileDir, { recursive: true, mode: 0o700 })
    const browserPath = await locate()
    const log = await open(logFile, 'a', 0o600)
    try { await spawn(browserPath, args, log.fd) } finally { await log.close() }
    await touch()
  }

  // Starts the browser if none is running and returns its CDP endpoint. Never kills a live browser.
  async function endpoint() {
    return withLock(async () => {
      const until = Date.now() + times.readyMs
      let launched = false
      for (;;) {
        const list = processes(), root = rootOf(list), health = await probe()
        if (root && health?.ours) { await touch(); return health.endpoint }
        if (!root && health) throw new Error(`Port ${port} is served by a browser shared-browser did not start`)
        if (!root) {
          if (launched) throw new Error(`Chrome exited before its DevTools endpoint answered; see ${logFile}`)
          await terminate(list) // helpers whose browser process is gone
          await launch()
          launched = true
        } else if (Date.now() >= until) {
          throw new Error(health
            ? `Port ${port} is served by a browser shared-browser did not start, while its own pid ${root.pid} runs; bin/shared-browser stop clears it`
            : `Shared browser pid ${root.pid} is running but http://127.0.0.1:${port}/json/version does not answer; bin/shared-browser stop clears it`)
        }
        await sleep(times.pollMs)
      }
    })
  }

  async function status() {
    const list = processes(), mine = owned(list), root = rootOf(list)
    const health = root ? await probe() : null
    const state = root ? (health?.ours ? 'running' : 'unresponsive') : mine.length ? 'orphaned' : 'stopped'
    const rssKiB = mine.reduce((sum, item) => sum + item.rssKiB, 0)
    const lastUsedAt = await stat(usedFile).then(info => info.mtimeMs, () => null)
    return {
      running: state === 'running', state, pid: root?.pid ?? null, endpoint: state === 'running' ? health.endpoint : null,
      browserPath: root ? root.command.split(` ${portArg}`)[0] : null,
      processCount: mine.length, rssKiB, rssMiB: Number((rssKiB / 1024).toFixed(1)), lastUsedAt,
    }
  }

  async function stop() {
    return withLock(() => terminate(processes()))
  }

  // Stops the browser when every CDP target is idle and no client asked for it within `minutes`.
  async function reap(minutes) {
    return withLock(async () => {
      const list = processes(), root = rootOf(list)
      if (!root) return await terminate(list) ? { result: 'reaped', pid: null } : { result: 'not running' }
      const health = await probe(), targets = health?.ours ? await json('/json/list') : null
      if (!Array.isArray(targets)) return { result: 'unresponsive', pid: root.pid }
      const lastUsed = await stat(usedFile).then(info => info.mtimeMs, () => null)
      if (lastUsed === null) await touch()
      const idleForMs = lastUsed === null ? 0 : Date.now() - lastUsed
      if (!targets.every(idleTarget) || idleForMs < minutes * 60_000) return { result: 'active', targetCount: targets.length, idleForMs }
      await terminate(processes())
      return { result: 'reaped', pid: root.pid }
    })
  }

  return { port, profileDir, logFile, args, endpoint, status, stop, reap, withLock }
}

// Chromium exposes its New Tab screen as page, iframe, and browser UI targets.
export function idleTarget(target) {
  const url = target.url ?? ''
  if (target.type === 'page') return url.startsWith('about:blank') || url === 'chrome://newtab/'
  return target.type === 'browser_ui' || target.type === 'iframe' && url.startsWith('chrome-untrusted://new-tab-page/')
}

async function executable(path) {
  try { await access(path, constants.X_OK); return true } catch { return false }
}

function bundles(versionDir, platform) {
  if (platform === 'darwin') return ['chrome-mac-arm64', 'chrome-mac-x64', 'chrome-mac'].flatMap(folder => [
    join(versionDir, folder, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    join(versionDir, folder, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  ])
  if (platform === 'linux') return [join(versionDir, 'chrome-linux64', 'chrome'), join(versionDir, 'chrome-linux', 'chrome')]
  return []
}

// Puppeteer caches Chrome for Testing as <root>/chrome/<platform>-<version>/<bundle>.
async function puppeteerBrowser(root, platform) {
  const versions = await readdir(join(root, 'chrome')).catch(() => [])
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  for (const version of versions) {
    for (const candidate of bundles(join(root, 'chrome', version), platform)) if (await executable(candidate)) return candidate
  }
  return null
}

// Playwright installs <root>/chromium-<revision>/<bundle> for the revision its package pins;
// headless-shell-only installs are not used.
async function playwrightRevisionPath() {
  try {
    const { chromium } = await import('playwright-core')
    return chromium.executablePath().match(/[\\/](chromium-\d+[\\/].+)$/)?.[1] ?? null
  } catch {
    return null
  }
}

export async function findBrowser({ env = process.env, home = env.HOME || homedir(), platform = process.platform, playwrightPath = playwrightRevisionPath } = {}) {
  for (const root of new Set([env.PUPPETEER_CACHE_DIR, join(home, '.cache', 'puppeteer'), join(home, 'Library', 'Caches', 'puppeteer')].filter(Boolean))) {
    const candidate = await puppeteerBrowser(root, platform)
    if (candidate) return candidate
  }

  const paths = (env.PATH || '').split(delimiter).filter(Boolean)
  const onPath = commands => paths.flatMap(directory => commands.map(command => join(directory, command)))
  const cft = platform === 'darwin' ? [
    join(home, 'Applications', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ] : platform === 'linux' ? onPath(['google-chrome-for-testing', 'chrome-for-testing']) : []
  for (const candidate of cft) if (await executable(candidate)) return candidate

  const revision = await playwrightPath()
  if (revision) {
    const roots = env.PLAYWRIGHT_BROWSERS_PATH === '0'
      ? [resolve(import.meta.dirname, '..', 'node_modules', 'playwright-core', '.local-browsers')]
      : env.PLAYWRIGHT_BROWSERS_PATH ? [env.PLAYWRIGHT_BROWSERS_PATH]
      : [join(home, '.cache', 'ms-playwright'), join(home, 'Library', 'Caches', 'ms-playwright')]
    for (const root of roots) if (await executable(join(root, revision))) return join(root, revision)
  }

  if (env.CHROME_PATH) {
    if (await executable(env.CHROME_PATH)) return resolve(env.CHROME_PATH)
    throw new Error(`CHROME_PATH is not an executable browser: ${env.CHROME_PATH}`)
  }
  const system = platform === 'darwin' ? [
    join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    join(home, 'Applications', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : []
  for (const candidate of [...system, ...onPath(['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'chrome'])]) {
    if (await executable(candidate)) return candidate
  }
  throw new Error('No Chrome for Testing, CHROME_PATH browser, or system Chrome/Chromium was found')
}

const formatRss = kib => kib >= 1024 * 1024 ? `${(kib / 1024 / 1024).toFixed(2)} GiB` : `${(kib / 1024).toFixed(1)} MiB`

export async function main([command, ...args], browser = sharedBrowser()) {
  if (command === 'start' || command === 'endpoint') console.log(await browser.endpoint())
  else if (command === 'status') {
    const current = await browser.status()
    if (args.includes('--json')) console.log(JSON.stringify(current, null, 2))
    else {
      console.log(`status: ${current.state}`)
      console.log(`pid: ${current.pid ?? 'none'}`)
      console.log(`endpoint: ${current.endpoint ?? 'none'}`)
      console.log(`processes: ${current.processCount}`)
      console.log(`RSS: ${formatRss(current.rssKiB)}`)
      if (current.browserPath) console.log(`browser: ${current.browserPath}`)
    }
  } else if (command === 'stop') console.log(await browser.stop() ? 'stopped' : 'not running')
  else if (command === 'reap') {
    const minutes = Number(args[0] ?? process.env.SHARED_BROWSER_IDLE_MINUTES ?? 30)
    if (!Number.isFinite(minutes) || minutes < 0) throw new Error(`Idle minutes must be non-negative; received ${args[0]}`)
    const result = await browser.reap(minutes)
    console.log(result.result === 'reaped' ? `reaped${result.pid ? ` pid ${result.pid}` : ' orphaned helpers'}`
      : result.result === 'active' ? `active: ${result.targetCount} CDP target(s), idle ${Math.floor(result.idleForMs / 60_000)}m`
      : result.result === 'unresponsive' ? `unresponsive: pid ${result.pid} does not answer CDP; left running` : result.result)
  } else console.log('Usage: bin/shared-browser <start|endpoint|status|stop|reap [idle-minutes]>')
}
