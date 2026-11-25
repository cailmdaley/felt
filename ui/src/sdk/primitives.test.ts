// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkPattern } from '@ui-sdk/core/testing'
import { ShuttleClient } from './client'
import {
  createActionMenu, createComposer, createFilePreview, createLifecycleBar, createPost, createTapestryFrame, createThreadRow,
  createTime, retimeAll,
} from './index'
import type { ShuttleFiber, ShuttleFiberDoc, ShuttlePostItem } from './types'

const NOW = Date.parse('2026-11-20T12:00:00Z')
/** Let bindings, responses and the SDK's focus return run: microtasks, and a few turns of the event loop for response bodies. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}
const fiber = (patch: Partial<ShuttleFiber> = {}, doc: Partial<ShuttleFiberDoc> = {}): ShuttleFiber => ({
  fiber: { id: 'work/fit-model', uid: 'U1', name: 'Fit the model', status: 'active', modified_at: '2026-11-20T11:48:00Z', outcome: 'Fitted the shear model', shuttle: { role: 'cosmology' }, ...doc },
  origin: 'remote', felt_store: '/s', path: 'work/fit-model.md', column: 'in_flight', turn: 'working', runtime: { state: 'running' }, ...patch,
})

/** A client whose writes are recorded and answered by `answer`. */
function recording(answer: () => Promise<Response> = async () => new Response('{}')) {
  const bodies: Array<{ path: string; body: unknown }> = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push({ path: String(input).replace('/api/v1', ''), body: JSON.parse(String(init?.body ?? 'null')) })
    return answer()
  }) as unknown as typeof globalThis.fetch
  return { client: new ShuttleClient({ fetch }), bodies }
}

/** Where a page's own errors surface. */
function uncaught() {
  const seen = vi.fn()
  vi.stubGlobal('reportError', seen)
  return seen
}

afterEach(async () => {
  vi.unstubAllGlobals()
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle()
  document.body.innerHTML = ''
})

/** No primitive dresses itself: no class, no inline style, anywhere in its tree. */
function unskinned(root: Element): void {
  for (const el of [root, ...root.querySelectorAll('*')]) {
    expect(el.getAttribute('style') ?? '', el.outerHTML).toBe('')
    expect(el.className && typeof el.className === 'string' ? el.className : '', el.tagName).toBe('')
  }
}

describe('createTime', () => {
  it('draws a relative age with its instant, and retimes in place', () => {
    const time = createTime(NOW - 12 * 60_000, NOW)
    expect(time.dataset.slot).toBe('shuttle-time')
    expect(time.textContent).toBe('12m ago')
    expect(time.dateTime).toBe('2026-11-20T11:48:00.000Z')
    expect(time.title).toMatch(/2026/)
    const short = createTime(NOW - 12 * 60_000, NOW, { short: true })
    const root = document.createElement('div')
    root.append(time, short)
    retimeAll(root, NOW + 3_600_000)
    expect([time.textContent, short.textContent]).toEqual(['1h ago', '1h'])
    expect(createTime(0, NOW).hasAttribute('datetime')).toBe(false)
  })
})

describe('createThreadRow', () => {
  it('draws a line: state, slug, doing and age, with its state on the root', () => {
    const row = createThreadRow(fiber(), { now: NOW })
    expect(row.dataset).toMatchObject({ slot: 'shuttle-thread-row', density: 'line', attention: 'working', turn: 'working', fiber: 'U1', origin: 'remote' })
    expect([...row.children].map(child => (child as HTMLElement).dataset.slot)).toEqual(['state', 'slug', 'doing', 'age'])
    expect(row.querySelector('[data-slot="slug"]')!.textContent).toBe('fit-model')
    expect(row.querySelector('[data-slot="doing"]')!.textContent).toBe('Fitted the shear model')
    expect(row.querySelector('[data-slot="age"] time')!.textContent).toBe('12m')
    expect(row.getAttribute('role')).toBeNull()
    unskinned(row)
  })

  it('draws a chip with its office, and flags an unreadable file', () => {
    const chip = createThreadRow(fiber({}, { unreadable: 'bad yaml' }), { now: NOW, density: 'chip' })
    expect([...chip.children].map(child => (child as HTMLElement).dataset.slot)).toEqual(['state', 'slug', 'role'])
    expect(chip.hasAttribute('data-unreadable')).toBe(true)
  })

  it('opens from a click, Enter or Space when given an opener', () => {
    const open = vi.fn()
    const row = createThreadRow(fiber(), { now: NOW, onOpen: open })
    document.body.append(row)
    expect(row.getAttribute('role')).toBe('button')
    expect(row.tabIndex).toBe(0)
    expect(row.getAttribute('aria-label')).toBe('fit-model, working: Fitted the shear model')
    row.click()
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(open).toHaveBeenCalledTimes(3)
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ origin: 'remote' }))
  })

  it('opens once while a key is held, inside any control, and leaves a control of its own its clicks', () => {
    const open = vi.fn()
    const row = createThreadRow(fiber(), { now: NOW, onOpen: open })
    const link = document.createElement('a')
    link.append(row)
    document.body.append(link)
    row.querySelector<HTMLElement>('[data-slot="slug"]')!.click()
    expect(open).toHaveBeenCalledTimes(1)
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true }))
    expect(open).toHaveBeenCalledTimes(2)
    row.appendChild(document.createElement('button')).click()
    expect(open).toHaveBeenCalledTimes(2)
  })
})

describe('createPost', () => {
  const item = (patch: Partial<ShuttlePostItem> = {}): ShuttlePostItem =>
    ({ id: 'p1', fiber: fiber(), kind: 'ask', text: 'Which **bin** edges?', at: NOW - 5 * 60_000, waiting: true, ...patch })

  it('draws its head, its words and its state', () => {
    const post = createPost(item(), { now: NOW })
    expect(post.tagName).toBe('ARTICLE')
    expect(post.dataset).toMatchObject({ slot: 'shuttle-post', kind: 'ask', fiber: 'U1' })
    expect(post.hasAttribute('data-waiting')).toBe(true)
    expect(post.hasAttribute('data-grouped')).toBe(false)
    const head = post.querySelector('[data-slot="head"]')!
    expect([...head.children].map(child => (child as HTMLElement).dataset.slot)).toEqual(['author', 'role', 'kind', 'age'])
    expect(head.querySelector('[data-slot="kind"]')!.textContent).toBe('asks')
    expect(post.querySelector('[data-slot="body"]')!.textContent).toBe('Which **bin** edges?')
    unskinned(post)
  })

  it('opens, clears, renders its words as asked and previews its files', () => {
    const open = vi.fn(), clear = vi.fn()
    const post = createPost(item({ kind: 'post', files: [{ fullPath: '/r/plot.png', basename: 'plot.png', timestamp: NOW, sessionId: null }] }), {
      now: NOW, grouped: true, onOpen: open, onClear: clear, client: new ShuttleClient(),
      renderText: text => Object.assign(document.createElement('strong'), { textContent: text.toUpperCase() }),
    })
    expect(post.hasAttribute('data-grouped')).toBe(true)
    expect(post.querySelector('[data-slot="kind"]')).toBeNull()
    post.querySelector<HTMLButtonElement>('[data-slot="author"]')!.click()
    post.querySelector<HTMLButtonElement>('[data-slot="clear"]')!.click()
    expect(open).toHaveBeenCalledOnce()
    expect(clear).toHaveBeenCalledOnce()
    expect(post.querySelector('[data-slot="body"] strong')!.textContent).toBe('WHICH **BIN** EDGES?')
    expect(post.querySelector('[data-slot="files"] [data-slot="shuttle-file-preview"]')!.getAttribute('data-kind')).toBe('figure')
  })
})

describe('createFilePreview', () => {
  const client = new ShuttleClient()

  it('previews a figure as an image and a page in a sandboxed frame, from its owner', async () => {
    const client = new ShuttleClient({ fetch: (async () => new Response('<!doctype html><title>Fit</title><p>The fit</p>')) as unknown as typeof globalThis.fetch })
    const figure = createFilePreview({ path: '/r/plot.png', at: NOW - 60_000, caption: 'the fit' }, client, { origin: 'remote', now: NOW })
    expect(figure.dataset.kind).toBe('figure')
    expect(figure.querySelector('img[data-slot="media"]')!.getAttribute('src')).toBe('/api/v1/file?path=%2Fr%2Fplot.png&origin=remote')
    expect(figure.querySelector('img')!.alt).toBe('plot.png')
    expect(figure.querySelector('[data-slot="caption"]')!.textContent).toBe('the fit')
    expect(figure.querySelector('[data-slot="age"] time')!.textContent).toBe('1m ago')
    const page = createFilePreview({ fullPath: '/r/tapestry.html', basename: 'tapestry.html', timestamp: null, sessionId: null }, client)
    expect(page.dataset.kind).toBe('page')
    const frame = page.querySelector<HTMLIFrameElement>('iframe[data-slot="media"]')!
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.hasAttribute('inert')).toBe(true)
    expect(frame.tabIndex).toBe(-1)
    // Its head is read first, for a declaration.
    await vi.waitFor(() => expect(frame.getAttribute('src')).toBe('/api/v1/file-assets/local/r/tapestry.html'))
    expect(page.querySelector('[data-slot="age"]')).toBeNull()
    unskinned(figure)
  })

  it('draws a page that declares a public page as a card naming its site, in no frame', async () => {
    const client = new ShuttleClient({ fetch: (async () => new Response('<!doctype html><head><meta name="shuttle-page" content="https://talks.example.org/deck/"></head>')) as unknown as typeof globalThis.fetch })
    const page = createFilePreview({ path: '/r/tapestry.html' }, client)
    await vi.waitFor(() => expect(page.dataset.kind).toBe('card'))
    expect(page.querySelector('iframe')).toBeNull()
    expect(page.querySelector('[data-slot="media"]')!.textContent).toBe('talks.example.org')
    unskinned(page)
  })

  it('draws a card or a row from its name alone, and opens from its name', () => {
    const open = vi.fn()
    const card = createFilePreview({ path: '/r/notes.md' }, client, { onOpen: open })
    expect(card.dataset.kind).toBe('card')
    expect(card.querySelector('[data-slot="media"]')!.textContent).toBe('MD')
    card.querySelector<HTMLButtonElement>('button[data-slot="name"]')!.click()
    expect(open).toHaveBeenCalledWith({ path: '/r/notes.md' })
    expect(createFilePreview({ path: '/r/plot.png' }, client, { kind: 'row' }).querySelector('img')).toBeNull()
  })
})

describe('createTapestryFrame', () => {
  it('frames the tapestry its owner found, sandboxed, once it is read, or says there is none', async () => {
    const fetch = vi.fn(async () => new Response('<!doctype html><title>Fit</title><p>The fit</p>')) as unknown as typeof globalThis.fetch
    const client = new ShuttleClient({ base: 'http://hub:4000', fetch })
    const framed = createTapestryFrame(fiber({ report_path: '/s/work/fit-model/tapestry.html' }), client)
    expect(framed.hasAttribute('data-empty')).toBe(false)
    await vi.waitFor(() => expect(framed.querySelector('iframe[data-slot="frame"]')).not.toBeNull())
    const frame = framed.querySelector<HTMLIFrameElement>('iframe[data-slot="frame"]')!
    // Only its head is read, for a declaration.
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('http://hub:4000/api/v1/file?path=%2Fs%2Fwork%2Ffit-model%2Ftapestry.html&origin=remote', { headers: { Range: 'bytes=0-65535' } })
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.src).toBe('http://hub:4000/api/v1/file-assets/remote/s/work/fit-model/tapestry.html')
    expect(new URL('fig.png', frame.src).href).toBe('http://hub:4000/api/v1/file-assets/remote/s/work/fit-model/fig.png')
    const empty = createTapestryFrame(fiber(), client, { emptyText: 'Nothing yet' })
    expect(empty.hasAttribute('data-empty')).toBe(true)
    expect(empty.querySelector('[data-slot="empty"]')!.textContent).toBe('Nothing yet')
    unskinned(framed)
  })

  it('frames a tapestry that declares itself a public page as that page, at its own origin', async () => {
    const declared = (url: string): Response => new Response(`<!doctype html><head><meta name="shuttle-page" content="${url}"></head><body></body>`)
    const at = (url: string): ShuttleClient => new ShuttleClient({ base: 'http://hub.example.org:4000', fetch: (async () => declared(url)) as unknown as typeof globalThis.fetch })
    const remote = createTapestryFrame(fiber({ report_path: '/s/work/talk/tapestry.html' }), at('https://talks.example.org/deck/'), { title: 'The talk' })
    await vi.waitFor(() => expect(remote.querySelector('iframe[data-slot="frame"]')).not.toBeNull())
    const frame = remote.querySelector<HTMLIFrameElement>('iframe[data-slot="frame"]')!
    expect(frame.getAttribute('src')).toBe('https://talks.example.org/deck/')
    expect(frame.getAttribute('sandbox')).toContain('allow-same-origin')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(frame.title).toBe('The talk')
    expect(remote.querySelectorAll('iframe')).toHaveLength(1)
    // The daemon's own host is never a remote page.
    const served = createTapestryFrame(fiber({ report_path: '/s/work/talk/tapestry.html' }), at('https://hub.example.org/deck/'))
    await vi.waitFor(() => expect(served.querySelector('iframe[data-slot="frame"]')?.getAttribute('sandbox')).toBe('allow-scripts'))
  })
})

describe('createActionMenu', () => {
  it('lists the fiber’s offers as an SDK menu that follows the menu pattern', async () => {
    const { client } = recording()
    const anchor = document.body.appendChild(document.createElement('button'))
    const menu = createActionMenu(fiber(), client)
    menu.open({ anchor })
    await settle()
    expect(menu.element.dataset.slot).toBe('shuttle-action-menu')
    const content = document.querySelector<HTMLElement>('[role="menu"]')!
    expect(content.getAttribute('aria-label')).toBe('Actions for Fit the model')
    expect([...content.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(item => [item.dataset.verb, item.textContent])).toEqual([
      ['review', 'Close for review'], ['rest', 'Rest'], ['temper', 'Temper'], ['discard', 'Discard'], ['kill', 'Stop worker'],
    ])
    expect(content.querySelector('[data-verb="discard"]')!.hasAttribute('data-destructive')).toBe(true)
    await checkPattern(content, 'menu')
    menu.destroy()
    await settle()
  })

  it('takes a chosen verb on the fiber’s owner, reports it, and returns focus to the anchor', async () => {
    const { client, bodies } = recording()
    const onAction = vi.fn()
    const anchor = document.body.appendChild(document.createElement('button'))
    const menu = createActionMenu(fiber(), client, { onAction })
    menu.open({ anchor })
    await settle()
    document.querySelector<HTMLElement>('[data-verb="temper"]')!.click()
    await settle()
    expect(bodies).toEqual([{ path: '/lifecycle', body: { action: 'close', tempered: true, fiber: 'work/fit-model', origin: 'remote' } }])
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ verb: 'temper' }), {})
    expect(document.querySelector('[role="menu"][data-open]')).toBeNull()
    expect(document.activeElement).toBe(anchor)
    menu.destroy()
    await settle()
    expect(menu.element.isConnected).toBe(false)
  })

  it('reads a listener that throws as the page’s error: the menu closes, and nothing was refused', async () => {
    const { client } = recording()
    const onError = vi.fn(), surfaced = uncaught()
    const menu = createActionMenu(fiber(), client, { onAction: () => { throw new Error('page bug') }, onError })
    menu.open({ anchor: document.body.appendChild(document.createElement('button')) })
    await settle()
    document.querySelector<HTMLElement>('[data-verb="rest"]')!.click()
    await settle()
    expect(onError).not.toHaveBeenCalled()
    expect(surfaced).toHaveBeenCalledWith(expect.objectContaining({ message: 'page bug' }))
    expect(document.querySelector('[role="menu"][data-open]')).toBeNull()
  })

  it('returns focus to what had it when its anchor takes none', async () => {
    const { client } = recording()
    const before = document.body.appendChild(document.createElement('input'))
    const anchor = document.body.appendChild(document.createElement('span'))
    const focus = vi.spyOn(anchor, 'focus')
    before.focus()
    const menu = createActionMenu(fiber(), client)
    menu.open({ anchor })
    await settle()
    menu.close()
    await settle()
    expect(focus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(before)
  })

  it('reports a refusal and stays open', async () => {
    const { client } = recording(async () => new Response(JSON.stringify({ error: 'not yours' }), { status: 400 }))
    const onError = vi.fn()
    const menu = createActionMenu(fiber(), client, { onError })
    menu.open({ anchor: document.body.appendChild(document.createElement('button')) })
    await settle()
    document.querySelector<HTMLElement>('[data-verb="kill"]')!.click()
    await settle()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'not yours' }), expect.objectContaining({ verb: 'kill' }))
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
  })
})

describe('createLifecycleBar', () => {
  it('draws the primary verbs in an SDK toolbar, leaving the worker’s stop to a menu', async () => {
    const { client } = recording()
    const bar = createLifecycleBar(fiber({ column: 'awaiting_review' }, { status: 'closed' }), client)
    document.body.append(bar)
    await settle()
    expect(bar.dataset.slot).toBe('shuttle-lifecycle-bar')
    expect(bar.querySelector('[role="toolbar"]')!.getAttribute('aria-label')).toBe('Lifecycle of Fit the model')
    expect([...bar.querySelectorAll<HTMLButtonElement>('button[data-verb]')].map(verb => [verb.dataset.verb, verb.textContent])).toEqual([
      ['temper', 'Temper'], ['discard', 'Discard'], ['reopen', 'Reopen'],
    ])
  })

  it('holds every verb while one runs, then reports it', async () => {
    let land!: (response: Response) => void
    const { client, bodies } = recording(() => new Promise(resolve => { land = resolve }))
    const onAction = vi.fn()
    const bar = createLifecycleBar(fiber(), client, { onAction })
    document.body.append(bar)
    await settle()
    const rest = bar.querySelector<HTMLButtonElement>('[data-verb="rest"]')!
    rest.click()
    await settle()
    expect(bar.getAttribute('aria-busy')).toBe('true')
    expect(rest.hasAttribute('data-pending')).toBe(true)
    expect([...bar.querySelectorAll('button[data-verb]')].every(verb => verb.getAttribute('aria-disabled') === 'true' && verb.hasAttribute('data-disabled'))).toBe(true)
    bar.querySelector<HTMLButtonElement>('[data-verb="temper"]')!.click()
    land(new Response('{}'))
    await settle()
    expect(bodies).toEqual([{ path: '/lifecycle', body: { action: 'rest', fiber: 'work/fit-model', origin: 'remote' } }])
    expect(onAction).toHaveBeenCalledOnce()
    expect(bar.hasAttribute('aria-busy')).toBe(false)
    expect(rest.hasAttribute('data-pending')).toBe(false)
  })

  it('reads a listener that throws as the page’s error, and frees the verbs', async () => {
    const { client } = recording()
    const onError = vi.fn(), surfaced = uncaught()
    const bar = createLifecycleBar(fiber(), client, { onAction: () => { throw new Error('page bug') }, onError })
    document.body.append(bar)
    await settle()
    bar.querySelector<HTMLButtonElement>('[data-verb="rest"]')!.click()
    await settle()
    expect(onError).not.toHaveBeenCalled()
    expect(surfaced).toHaveBeenCalledWith(expect.objectContaining({ message: 'page bug' }))
    expect(bar.hasAttribute('aria-busy')).toBe(false)
  })

  it('reports a refusal and frees the verbs', async () => {
    const { client, bodies } = recording(async () => new Response('busy', { status: 409 }))
    const onError = vi.fn()
    const bar = createLifecycleBar(fiber(), client, { onError })
    document.body.append(bar)
    await settle()
    bar.querySelector<HTMLButtonElement>('[data-verb="review"]')!.click()
    await settle()
    expect(bodies).toHaveLength(1)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'busy' }), expect.objectContaining({ verb: 'review' }))
    expect(bar.hasAttribute('aria-busy')).toBe(false)
  })
})

describe('createComposer', () => {
  it('sends with ⌘/Ctrl+Enter through dispatch on the owner, then clears', async () => {
    const { client, bodies } = recording()
    const onSent = vi.fn()
    const form = createComposer(fiber(), client, { onSent, messageId: () => 'human-1' })
    document.body.append(form)
    expect(form.dataset.slot).toBe('shuttle-composer')
    const input = form.querySelector<HTMLTextAreaElement>('textarea[data-slot="input"]')!
    input.value = '  use 20 bins  '
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
    await settle()
    expect(bodies).toEqual([{ path: '/dispatch', body: { fiber_id: 'work/fit-model', origin: 'remote', force: true, ad_hoc: true, resume_mode: 'continue', user_message: 'use 20 bins', message_id: 'human-1' } }])
    expect(input.value).toBe('')
    expect(onSent).toHaveBeenCalledWith({}, 'use 20 bins')
    unskinned(form)
  })

  it('sends the chosen mode, and nothing for an empty message', async () => {
    const { client, bodies } = recording()
    const form = createComposer(fiber(), client, { modes: true })
    document.body.append(form)
    await settle()
    const control = form.querySelector<HTMLElementTagNameMap['ui-segmented-control']>('[data-slot="modes"] ui-segmented-control')!
    expect(control.querySelectorAll('[role="radio"]')).toHaveLength(3)
    form.requestSubmit()
    await settle()
    expect(bodies).toEqual([])
    control.api!.setValue('fresh')
    await settle()
    form.querySelector('textarea')!.value = 'start over'
    form.querySelector<HTMLButtonElement>('button[data-slot="submit"]')!.click()
    await settle()
    expect(bodies).toEqual([{ path: '/dispatch', body: expect.objectContaining({ user_message: 'start over', resume_mode: 'fresh' }) }])
    expect((bodies[0].body as { message_id: string }).message_id).toMatch(/^human-[0-9a-f]{32}$/)
  })

  /** Sends `text` from the form and answers the body it posted. */
  const sendOf = (form: HTMLFormElement, bodies: Array<{ body: unknown }>) => async (text: string): Promise<{ message_id: string; resume_mode: string }> => {
    form.querySelector('textarea')!.value = text
    form.requestSubmit()
    await settle()
    return bodies.at(-1)!.body as { message_id: string; resume_mode: string }
  }

  it('retries a message under its id, and gives a sent, changed or differently sent one a new id', async () => {
    let refuse = true
    const { client, bodies } = recording(async () => refuse ? new Response('busy', { status: 503 }) : new Response('{"dispatched":true}'))
    const form = createComposer(fiber(), client, { modes: true })
    document.body.append(form)
    await settle()
    const send = sendOf(form, bodies)
    const first = await send('use 20 bins')
    expect((await send('use 20 bins')).message_id).toBe(first.message_id)
    const changed = await send('use 30 bins')
    expect(changed.message_id).not.toBe(first.message_id)
    form.querySelector<HTMLElementTagNameMap['ui-segmented-control']>('ui-segmented-control')!.api!.setValue('previous')
    await settle()
    const other = await send('use 30 bins')
    expect(other).toMatchObject({ resume_mode: 'previous' })
    expect(other.message_id).not.toBe(changed.message_id)
    refuse = false
    expect((await send('use 30 bins')).message_id).toBe(other.message_id)
    expect((await send('use 30 bins')).message_id).not.toBe(other.message_id)
  })

  it('keeps a message whose first send the owner cannot confirm, and sends it again as a new one', async () => {
    const answers = ['{"dispatched":false,"duplicate":true,"disposition":"unknown"}', '{"dispatched":false,"duplicate":true,"disposition":"delivered"}']
    const { client, bodies } = recording(async () => new Response(answers.shift()))
    const onSent = vi.fn(), onError = vi.fn()
    const form = createComposer(fiber(), client, { onSent, onError })
    document.body.append(form)
    const send = sendOf(form, bodies)
    const first = await send('hello')
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/may not have arrived/) }), 'hello')
    expect(form.querySelector('textarea')!.value).toBe('hello')
    expect((await send('hello')).message_id).not.toBe(first.message_id)
    expect(onSent).toHaveBeenCalledOnce()
    expect(form.querySelector('textarea')!.value).toBe('')
  })

  it('keeps the focus on its button while it sends, and sends once', async () => {
    let land!: (response: Response) => void
    const { client, bodies } = recording(() => new Promise(resolve => { land = resolve }))
    const form = createComposer(fiber(), client)
    document.body.append(form)
    form.querySelector('textarea')!.value = 'hello'
    const submit = form.querySelector<HTMLButtonElement>('button[data-slot="submit"]')!
    submit.focus()
    submit.click()
    await settle()
    expect(form.getAttribute('aria-busy')).toBe('true')
    expect(submit.getAttribute('aria-disabled')).toBe('true')
    expect(submit.disabled).toBe(false)
    expect(document.activeElement).toBe(submit)
    submit.click()
    land(new Response('{}'))
    await settle()
    expect(bodies).toHaveLength(1)
    expect(form.hasAttribute('aria-busy')).toBe(false)
    expect(submit.hasAttribute('aria-disabled')).toBe(false)
  })

  it('reads a listener that throws as the page’s error: the message was sent', async () => {
    const { client } = recording()
    const onError = vi.fn(), surfaced = uncaught()
    const form = createComposer(fiber(), client, { onSent: () => { throw new Error('page bug') }, onError })
    document.body.append(form)
    form.querySelector('textarea')!.value = 'hello'
    form.requestSubmit()
    await settle()
    expect(onError).not.toHaveBeenCalled()
    expect(surfaced).toHaveBeenCalledWith(expect.objectContaining({ message: 'page bug' }))
    expect(form.querySelector('textarea')!.value).toBe('')
    expect(form.hasAttribute('aria-busy')).toBe(false)
  })

  it('keeps the message and reports a refusal', async () => {
    const { client } = recording(async () => new Response(JSON.stringify({ error: 'no worker' }), { status: 422 }))
    const onError = vi.fn()
    const form = createComposer(fiber(), client, { onError })
    document.body.append(form)
    form.querySelector('textarea')!.value = 'hello'
    form.requestSubmit()
    await settle()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'no worker' }), 'hello')
    expect(form.querySelector('textarea')!.value).toBe('hello')
    expect(form.hasAttribute('aria-busy')).toBe(false)
  })
})
