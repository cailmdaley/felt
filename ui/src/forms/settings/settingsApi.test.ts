/**
 * The settings plane's decidable half: what comes off the origins feed, where
 * the routing key rides on the wire, and what a refusal READS as.
 *
 * Nothing here needs a daemon — `fetch` is a recorder — and nothing re-derives
 * a payload the daemon would have sent. Four subjects, each one a way this
 * file can be wrong that nobody notices until it matters:
 *
 * O1 — ORIGIN IS THE SAFETY PROPERTY of this page. Every read and every write
 *      is addressed to a host, as `?origin=` on a GET and `origin:` in the
 *      body on a POST, and the daemon owner-routes it from there. Getting it
 *      wrong writes one machine's configuration onto another — silently, and
 *      with a 200. So every assertion below is made against the URL and the
 *      body the stub actually RECEIVED; a test that rebuilt the expected
 *      request from the same inputs would pin nothing.
 * O2 — A LOCAL HOST SENDS NO PARAMETER AT ALL, not an empty one. The daemon
 *      routes on the parameter's presence, and `?origin=` is a present name
 *      that happens to be blank. On a write the rule inverts: `origin` is
 *      always in the body, `''` included, because there the body is the whole
 *      address and an absent key is a different shape from an empty one.
 *      EVERY call is routed, the folder dialog and the quarantine release
 *      included — only the daemon on a machine can raise a dialog on its
 *      screen or arm its own worker loop.
 * O3 — THE DAEMON'S OWN WORDS, unwrapped. A refused config write carries
 *      felt's diagnostic verbatim (`remote "b": port 4001 already used by
 *      "a"`), and a wrapper line ("Save failed: …") pushes the part that says
 *      what to fix off the end of a phone's error banner. The one exception is
 *      Phoenix's own 404, which on this page means exactly one thing — that
 *      host's daemon predates the settings API — and has to say so, because
 *      "Not Found" sends someone hunting for a missing file.
 * D1 — PRESENT-VS-ABSENT IS THE PROTOCOL for `expected_digest`, the same way
 *      the resting drop's due key is (see boardWire.test.ts). A digest — `null`
 *      included — says "refuse if the bytes moved since I read them"; no key
 *      at all says last-write-wins. The board is reachable from two hubs and a
 *      phone at once, so the difference is a file one of them silently loses.
 *
 * The components above this file are not covered here: their logic is JSX and
 * effects, and there is no DOM in this suite by design.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import * as api from './settingsApi.js'
import {
  loadConfigFile,
  loadHostState,
  loadHosts,
  saveConfigFile,
  type SettingsHost,
} from './settingsApi.js'

// ── The recorder ─────────────────────────────────────────────────────────────

const BASE = 'http://daemon.test:4000'

interface Call {
  url: string
  method: string
  /** The parsed JSON body, or null for a GET. */
  body: Record<string, unknown> | null
}

/** Replace `fetch` with a recorder answering every call from `respond`. */
function recorder(respond: (url: string) => Response): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.body
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : null,
    })
    return respond(String(input))
  })
  return calls
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

/**
 * The message a call rejects with — and a failure if it did not reject.
 *
 * Written as an exact string rather than `rejects.toThrow`, which matches on a
 * SUBSTRING and would therefore pass on precisely the thing O3 forbids: a
 * daemon sentence with a wrapper line in front of it.
 */
async function rejection(p: Promise<unknown>): Promise<string> {
  const outcome = await p.then(
    (value) => ({ rejected: false as const, value }),
    (err: unknown) => ({ rejected: true as const, message: (err as Error).message }),
  )
  if (!outcome.rejected) {
    throw new Error(`expected a rejection; resolved with ${JSON.stringify(outcome.value)}`)
  }
  return outcome.message
}

afterEach(() => vi.unstubAllGlobals())

const local: SettingsHost = {
  origin: '',
  host: 'laptop',
  label: 'laptop',
  isLocal: true,
  stale: false,
  nativeFolderPicker: true,
  expandedFeltStores: [],
  hubHost: 'laptop',
}

/** A remote whose routing key and self-reported id DIFFER, which is the pair
 *  every origin assertion below needs in order to say anything. */
const remote: SettingsHost = {
  ...local,
  origin: 'candide',
  host: 'candide-node-7',
  label: 'Candide',
  isLocal: false,
  nativeFolderPicker: false,
  expandedFeltStores: null,
}

// ── The host list ────────────────────────────────────────────────────────────

describe('loadHosts', () => {
  /** The origins feed, with the local host deliberately NOT written first: the
   *  ordering assertion has to be about the sort, not about the payload. */
  const FEED = {
    host: 'laptop',
    origins: {
      candide: {
        kind: 'remote',
        host: 'candide-node-7',
        display: 'Candide',
        stale: true,
        felt_stores: ['/home/x/loom'],
        projects: ['/home/x/dev/cmbx'],
      },
      laptop: {
        kind: 'local',
        host: 'laptop',
        native_folder_picker: true,
        felt_stores: ['/Users/x/loom'],
        expanded_felt_stores: ['/Users/x/loom', '/Users/x/loom/sub'],
        projects: ['/Users/x/dev/felt'],
      },
      amundsen: { kind: 'remote', host: 'amundsen' },
    },
  }

  const hosts = (feed: unknown = FEED): Promise<SettingsHost[]> => {
    recorder(() => json(feed))
    return loadHosts(BASE)
  }

  it('puts the local host first, then the remotes alphabetically', async () => {
    // `amundsen` before `Candide` is `localeCompare`, not `<`: a raw string
    // comparison sorts every capitalised display name above every lowercase
    // one, which reads as no order at all.
    expect((await hosts()).map((h) => h.label)).toEqual(['laptop', 'amundsen', 'Candide'])
  })

  it('uses the empty string for the local origin and the map KEY for a remote', async () => {
    const rows = await hosts()
    expect(rows[0]).toMatchObject({ origin: '', host: 'laptop', isLocal: true })
    // O1. The routing key is the key the hub filed the remote under, NOT what
    // the remote calls itself — the two differ here on purpose, and routing on
    // `host` would address a machine the hub has never heard of.
    expect(rows[2]).toMatchObject({ origin: 'candide', host: 'candide-node-7', isLocal: false })
  })

  it('reads a host that merely matches the feed’s own host id as local', async () => {
    // An older daemon's origin block carries no `kind`. Being the host the
    // feed says it IS has to be enough, or the page would offer to configure
    // the machine it is running on as though it were a remote — and send the
    // writes back out over a tunnel to itself.
    const rows = await hosts({ host: 'laptop', origins: { laptop: { kind: 'remote' } } })
    expect(rows[0]).toMatchObject({ origin: '', isLocal: true, host: 'laptop' })
  })

  it('carries each host’s own flags and store expansion through untouched', async () => {
    const rows = await hosts()
    expect(rows[0]).toMatchObject({
      stale: false,
      nativeFolderPicker: true,
      expandedFeltStores: ['/Users/x/loom', '/Users/x/loom/sub'],
    })
    expect(rows[2]).toMatchObject({ stale: true })
  })

  it('leaves a remote’s missing expansion NULL rather than empty', async () => {
    // null and [] are different claims. [] says "this host follows its
    // symlinks out to nothing", which the store section would draw as a
    // difference from the configured list; null says the hub has no claim to
    // make about a remote's symlinks, which is the truth about every one.
    expect((await hosts())[2].expandedFeltStores).toBeNull()
  })

  it('lets each host answer for its own folder dialog, remotes included', async () => {
    // Not a local-only flag. A remote WITH a desktop can raise a dialog on it
    // and says so; a headless node says false and the section asks for a typed
    // path instead. Deciding that from here — "remotes are never native" —
    // would take the picker away from the machine most worth pointing at, and
    // an absent flag is the only thing that may be read as false.
    const rows = await hosts({
      host: 'laptop',
      origins: {
        candide: { kind: 'remote', native_folder_picker: true },
        cineca: { kind: 'remote' },
      },
    })
    expect(rows.map((h) => h.nativeFolderPicker)).toEqual([true, false])
  })

  it('falls back through display → host → key for the label', async () => {
    const rows = await hosts({
      host: 'laptop',
      origins: { laptop: { kind: 'local' }, nibi: { kind: 'remote' } },
    })
    expect(rows.map((h) => h.label)).toEqual(['laptop', 'nibi'])
    expect(rows[1].host).toBe('nibi')
  })

  it('answers an empty list rather than inventing a host', async () => {
    // SettingsDialog has a page for exactly this and it says the daemon is
    // probably not answering. A fabricated local row would replace that with a
    // settings sheet whose every write goes nowhere.
    expect(await hosts({ host: 'laptop' })).toEqual([])
  })
})

// ── Where the origin rides ───────────────────────────────────────────────────

describe('the origin on the wire', () => {
  type Routed = [
    name: keyof typeof api,
    call: (host: SettingsHost) => Promise<unknown>,
    wire: { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown> },
  ]

  /** Every call addressed to a host, with what it sends besides the origin. */
  const ROUTED: Routed[] = [
    ['loadConfigIndex', (h) => api.loadConfigIndex(BASE, h), { method: 'GET', path: '/api/v1/config' }],
    ['loadConfigFile', (h) => api.loadConfigFile(BASE, h, 'stores'), { method: 'GET', path: '/api/v1/config/stores' }],
    ['loadAgents', (h) => api.loadAgents(BASE, h), { method: 'GET', path: '/api/v1/agents' }],
    ['loadFleet', (h) => api.loadFleet(BASE, h), { method: 'GET', path: '/api/v1/fleet' }],
    ['saveConfigFile', (h) => api.saveConfigFile(BASE, h, 'stores', '{"a":1}'),
      { method: 'POST', path: '/api/v1/config/stores', body: { text: '{"a":1}' } }],
    ['saveStores', (h) => api.saveStores(BASE, h, ['/x/loom']),
      { method: 'POST', path: '/api/v1/felt-stores', body: { felt_stores: ['/x/loom'] } }],
    ['saveProjects', (h) => api.saveProjects(BASE, h, ['/x/dev']),
      { method: 'POST', path: '/api/v1/projects', body: { projects: ['/x/dev'] } }],
    ['addProject', (h) => api.addProject(BASE, h, '/x/dev'),
      { method: 'POST', path: '/api/v1/projects', body: { path: '/x/dev' } }],
    // A folder dialog is owner-routed too: only the daemon ON a machine can
    // raise one there, so the origin decides WHICH screen it appears on.
    // Whether a host may be asked at all is `nativeFolderPicker`, at the call
    // site.
    ['chooseFolder', (h) => api.chooseFolder(BASE, h), { method: 'POST', path: '/api/v1/choose-folder', body: {} }],
    ['setAgentEffort', (h) => api.setAgentEffort(BASE, h, 'claude-opus', 'high'),
      { method: 'POST', path: '/api/v1/agents/effort', body: { id: 'claude-opus', effort: 'high' } }],
    // null is the reset.
    ['setAgentEffort', (h) => api.setAgentEffort(BASE, h, 'claude-opus', null),
      { method: 'POST', path: '/api/v1/agents/effort', body: { id: 'claude-opus', effort: null } }],
    ['saveRemote', (h) => api.saveRemote(BASE, h, { name: 'nibi', ssh: 'nibi' }),
      { method: 'POST', path: '/api/v1/fleet/remotes', body: { name: 'nibi', ssh: 'nibi' } }],
    ['removeRemote', (h) => api.removeRemote(BASE, h, 'nibi'),
      { method: 'POST', path: '/api/v1/fleet/remotes', body: { name: 'nibi', remove: true } }],
    ['runTunnels', (h) => api.runTunnels(BASE, h, 'install', 'nibi'),
      { method: 'POST', path: '/api/v1/tunnels', body: { action: 'install', name: 'nibi' } }],
    // The one write that changes what a daemon will DO rather than what it
    // reads. Sent to the wrong machine it starts workers on it.
    ['releaseQuarantine', (h) => api.releaseQuarantine(BASE, h),
      { method: 'POST', path: '/api/v1/quarantine/release', body: {} }],
  ]

  /** The exported functions that name no host on the wire, each for a reason. */
  const UNROUTED = new Set<keyof typeof api>([
    'loadHosts', // the origins feed itself
    'loadVersion', // this daemon's own build
    'resetRemote', // addressed by the remote's name in the path
    'loadHostState', // the hub's cached fan-out, read in one call
    'DaemonRefusal', // the refusal type and its predicates, not requests
    'isConflict',
    'isUnavailable',
  ])

  it('rides in the query on a remote read, nowhere on a local one, and in every write’s body', async () => {
    // O2: `?origin=` is a name, and a blank name is not the same question as
    // no name at all — so a local read has no query. On a write the body IS
    // the address, so `origin` is always there, `''` included, and the path
    // stays bare. `toEqual` on the whole body so an extra key is a failure.
    const sent: unknown[] = []
    const want: unknown[] = []
    for (const [name, call, wire] of ROUTED) {
      for (const host of [local, remote]) {
        const calls = recorder(() => json({ ok: true }))
        await call(host)
        const as = `${name} on ${host.label}`
        const query = wire.method === 'GET' && host.origin ? `?origin=${host.origin}` : ''
        sent.push({ as, method: calls[0]?.method, url: calls[0]?.url, body: calls[0]?.body })
        want.push({
          as,
          method: wire.method,
          url: `${BASE}${wire.path}${query}`,
          body: wire.method === 'POST' ? { ...wire.body, origin: host.origin } : null,
        })
        vi.unstubAllGlobals()
      }
    }
    expect(sent).toEqual(want)
  })

  it('names the routing of every exported function', () => {
    // A new call must say which side it is on before it can ship.
    const requests = Object.entries(api)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
    const named = new Set<string>([...ROUTED.map(([name]) => name), ...UNROUTED])
    expect(requests.filter((name) => !named.has(name))).toEqual([])
  })
})

// ── Two devices, one file ────────────────────────────────────────────────────

describe('saveConfigFile’s expected_digest', () => {
  const saved = (): Response => json({ id: 'stores', text: '[]', digest: 'sha256:new' })

  it('sends back the digest the read handed out', async () => {
    const calls = recorder(saved)
    await saveConfigFile(BASE, remote, 'stores', '[]', 'sha256:old')
    expect(calls[0].body).toEqual({
      text: '[]',
      origin: 'candide',
      expected_digest: 'sha256:old',
    })
  })

  it('sends NULL for a file that did not exist — still a claim, not a shrug', async () => {
    // D1, the half that is easy to lose. `null` says "I read this file and it
    // was not there", so a daemon that now finds one refuses. Collapsing that
    // to "no opinion" is exactly the race two devices lose: both create the
    // file, and the second one silently wins.
    const calls = recorder(saved)
    await saveConfigFile(BASE, remote, 'stores', '[]', null)
    expect(calls[0].body).toEqual({ text: '[]', origin: 'candide', expected_digest: null })
  })

  it('omits the key entirely when no digest is given, which is last-write-wins', async () => {
    // D1's other half, and why the branch asks `=== undefined` rather than
    // truthiness: absent is a DIFFERENT instruction from null, not a weaker
    // one. Right for a script, wrong for a human with two devices — so the
    // key's absence is the thing to pin, not just its value.
    const calls = recorder(saved)
    await saveConfigFile(BASE, remote, 'stores', '[]')
    expect(calls[0].body).toEqual({ text: '[]', origin: 'candide' })
    expect('expected_digest' in (calls[0].body ?? {})).toBe(false)
  })
})

// ── What a refusal reads as ──────────────────────────────────────────────────

describe('refusals', () => {
  it('is the daemon’s own sentence, with nothing prepended', async () => {
    // O3. This is the diagnostic that names the port and the two remotes
    // fighting over it; anything in front of it costs the reader the end.
    recorder(() => json({ ok: false, error: 'remote "b": port 4001 already used by "a"' }, 422))
    expect(await rejection(saveConfigFile(BASE, local, 'remotes', '{}'))).toBe(
      'remote "b": port 4001 already used by "a"',
    )
  })

  it('reads Phoenix’s own 404 as a host that predates the settings API', async () => {
    // The shape a not-yet-deployed remote returns: the ROUTE does not exist,
    // so Phoenix answers in its own words rather than ours. "Not Found" would
    // send someone looking for a missing config FILE; what is missing is the
    // deploy, and only this branch can say so.
    recorder(() => json({ errors: { detail: 'Not Found' } }, 404))
    expect(await rejection(loadConfigFile(BASE, remote, 'agents'))).toBe(
      'Candide has no settings API — its daemon predates it. Deploy that host to configure it from here.',
    )
  })

  it('says “this host” when the call names no host', async () => {
    // `loadHosts` is addressed to the daemon serving the
    // page and pass no label at all, so the sentence has to read without one
    // rather than open on a blank.
    recorder(() => json({ errors: { detail: 'Not Found' } }, 404))
    expect(await rejection(loadHosts(BASE))).toBe(
      'this host has no settings API — its daemon predates it. Deploy that host to configure it from here.',
    )
  })

  it('keeps our own words on a 404 that carries them', async () => {
    // The branch order is load-bearing. A 404 from OUR controller is a real
    // answer from a live route, and calling it an undeployed daemon would send
    // someone off to redeploy a perfectly healthy host.
    recorder(() => json({ ok: false, error: 'no such config file: remotes' }, 404))
    expect(await rejection(loadConfigFile(BASE, remote, 'remotes'))).toBe(
      'no such config file: remotes',
    )
  })

  it('falls back to the status when the body says nothing', async () => {
    // A proxy's HTML error page, or a bare 502 — not JSON, and not ours.
    recorder(() => new Response('<html>bad gateway</html>', { status: 502 }))
    expect(await rejection(loadConfigFile(BASE, remote, 'stores'))).toBe('the daemon answered 502')
  })

  // A dead daemon throws instead of answering, and none of the three engines
  // agrees on what to call it. The detection is therefore by TYPE — the fetch
  // spec guarantees a TypeError for a transport failure and says nothing about
  // the wording — and these three cases are the engines, named, because a
  // predicate that read the message passed the first two and failed the third.
  // The third is Safari, which is the phone, which is why this page exists.
  it.each([
    ['Chrome', 'Failed to fetch'],
    ['Firefox', 'NetworkError when attempting to fetch resource.'],
    ['WebKit', 'Load failed'],
  ])('names the daemon when the fetch itself never lands (%s)', async (_engine, message) => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError(message)))
    expect(await rejection(loadHosts(BASE))).toBe('Couldn’t reach the Shuttle daemon (:4000).')
  })

  it('refuses an answer the HUB gave to a request addressed to a remote', async () => {
    // What a degrade-to-local looks like from here: the request named a remote,
    // and the daemon serving the page answered it about itself. The daemon
    // refuses that origin now, so this is the second of two guards — and the
    // one that would still catch an older daemon on the other end of a hub.
    recorder(() => new Response(JSON.stringify({ host: 'laptop', text: 'mine' }), { status: 200 }))
    expect(await rejection(loadConfigFile(BASE, remote, 'stores'))).toContain(
      'came from laptop, the hub',
    )
  })

  it('accepts a remote whose own id differs from its fleet name', async () => {
    // `SettingsHost.host` is the ROUTING key; a remote's `~/.shuttle/host` is
    // its own name for itself, and the two are allowed to differ. A guard that
    // demanded they match would refuse working answers on a correct fleet —
    // which is why the check asks the narrow question instead of the obvious
    // one. This fixture is exactly that pair.
    recorder(() =>
      new Response(JSON.stringify({ host: 'some-other-id', text: 'theirs' }), { status: 200 }),
    )
    await expect(loadConfigFile(BASE, remote, 'stores')).resolves.toMatchObject({
      text: 'theirs',
    })
  })

  it('passes an error that is not a transport failure through untouched', async () => {
    // Not a TypeError, so it came from our own code and is already a sentence.
    // Renaming it would replace a real diagnosis with a guess about the network.
    vi.stubGlobal('fetch', () => Promise.reject(new Error('operation was aborted')))
    expect(await rejection(loadHosts(BASE))).toBe('operation was aborted')
  })
})

// ── One composite, every host ────────────────────────────────────────────────

describe('loadHostState', () => {
  const COMPOSITE = {
    local: { host: 'laptop', felt_stores: ['/Users/x/loom'] },
    remotes: {
      candide: { snapshot: { host: 'candide-node-7' }, stale: true },
      nibi: { snapshot: null, last_error: 'ssh: connect: timed out' },
    },
  }

  it('reads the hub’s cached fan-out in one un-routed call', async () => {
    // Deliberately NOT owner-routed: the hub already polls every remote into
    // this one document, so a remote's state costs a lookup rather than a hop
    // over the tunnel — and it is the same cached row the board draws from.
    const calls = recorder(() => json(COMPOSITE))
    await loadHostState(BASE, remote)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${BASE}/api/v1/state/composite`)
  })

  it('takes the local block for the local host', async () => {
    recorder(() => json(COMPOSITE))
    expect(await loadHostState(BASE, local)).toMatchObject({ host: 'laptop' })
  })

  it('looks a remote up by its routing key, not by what it calls itself', async () => {
    // Same pairing as O1, one level in: the composite files remotes under the
    // hub's key, so `host` would miss every remote whose id differs from it.
    recorder(() => json(COMPOSITE))
    expect(await loadHostState(BASE, remote)).toMatchObject({ host: 'candide-node-7' })
  })

  it('answers null for a remote the hub could not reach', async () => {
    // A null snapshot is a FACT about that host. HostSection says so, rather
    // than drawing an empty build stamp as though it had asked and got blanks.
    recorder(() => json(COMPOSITE))
    expect(await loadHostState(BASE, { ...remote, origin: 'nibi', label: 'nibi' })).toBeNull()
  })

  it('answers null for a host the composite does not mention at all', async () => {
    recorder(() => json({ local: {}, remotes: {} }))
    expect(await loadHostState(BASE, remote)).toBeNull()
  })
})
