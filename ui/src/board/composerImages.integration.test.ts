// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Dock, type MeetingJoinControl } from './workspace/Dock.js'
import { card } from './testFixtures'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function png(name: string): File {
  const f = new File([PNG as unknown as BlobPart], name, { type: 'image/png' })
  // jsdom's Blob predates arrayBuffer(); the browser's has it.
  if (typeof f.arrayBuffer !== 'function') {
    Object.defineProperty(f, 'arrayBuffer', { value: async () => PNG.slice().buffer })
  }
  return f
}

function paste(target: HTMLElement, files: File[], text = ''): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { files, items: [], getData: (type: string) => (type === 'text/plain' ? text : '') },
  })
  target.dispatchEvent(event)
  return event
}

const defer = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}
const uploaded = (...paths: string[]) => ({
  ok: true, status: 200, json: async () => ({ files: paths.map((path) => ({ path })) }),
})
const dispatched = { ok: true, status: 200, json: async () => ({ tmux_session: 'w' }) }

let composer: HTMLElement
let fetch: ReturnType<typeof vi.fn>
let panel: Dock

interface PanelInternals {
  buildComposer(c: ReturnType<typeof card>, swallow: (el: HTMLElement) => void): HTMLElement
  pendingStartPrompt: { cardId: string; body: unknown } | null
}

/** A fresh panel and composer for `work/task`, optionally with a meeting
 *  control and a start prompt waiting for the card. */
function mount(opts: { meeting?: MeetingJoinControl; pendingStart?: boolean } = {}): void {
  document.body.innerHTML = ''
  panel = new Dock('https://daemon.example', vi.fn(), undefined, undefined,
    opts.meeting ? { meeting: opts.meeting } : undefined)
  const internals = panel as unknown as PanelInternals
  if (opts.pendingStart) {
    internals.pendingStartPrompt = {
      cardId: 'work/task',
      body: { dispatched: false, reason: 'arm_refused', needs: 'project_dir', host: 'cluster', message: 'no project_dir' },
    }
  }
  composer = internals.buildComposer.call(panel, card({ id: 'work/task', originId: 'cluster' }), () => {})
  document.body.append(composer)
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  let n = 0
  URL.createObjectURL = vi.fn(() => `blob:thumb-${++n}`)
  URL.revokeObjectURL = vi.fn()
  fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  mount()
})

afterEach(() => {
  panel.reset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const textarea = (): HTMLTextAreaElement => composer.querySelector('textarea')!
const chips = (): HTMLElement[] => [...composer.querySelectorAll<HTMLElement>('.kbn-ctl-image')]
const error = (): HTMLElement => composer.querySelector<HTMLElement>('.kbn-detail-error:not(.kbn-ctl-images-error)')!
const imageError = (): HTMLElement => composer.querySelector<HTMLElement>('.kbn-ctl-images-error')!
const button = (label: string): HTMLButtonElement =>
  [...composer.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)!
const resume = (): HTMLButtonElement => button('Resume')
const fresh = (): HTMLButtonElement => button('New session')

describe('the composer takes pasted images', () => {
  it('shows a chip per pasted image, with a working remove control', () => {
    expect(composer.querySelector<HTMLElement>('.kbn-ctl-images')!.hidden).toBe(true)
    const event = paste(textarea(), [png('one.png'), png('two.png')])
    expect(event.defaultPrevented).toBe(true)
    expect(chips()).toHaveLength(2)
    expect(chips()[0].querySelector('img')!.getAttribute('src')).toBe('blob:thumb-1')
    expect(composer.querySelector<HTMLElement>('.kbn-ctl-images')!.hidden).toBe(false)

    chips()[0].querySelector<HTMLButtonElement>('.kbn-ctl-image-remove')!.click()
    expect(chips()).toHaveLength(1)
    expect(chips()[0].querySelector('img')!.alt).toBe('two.png')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:thumb-1')
  })

  it('leaves a text-only paste to the textarea', () => {
    const event = paste(textarea(), [])
    expect(event.defaultPrevented).toBe(false)
    expect(chips()).toHaveLength(0)
  })

  it('leaves a paste that carries text to the textarea, even with an image beside it', () => {
    // An office app copies a selection as text/plain plus a rendered PNG.
    const event = paste(textarea(), [png('rendered.png')], 'a copied paragraph')
    expect(event.defaultPrevented).toBe(false)
    expect(chips()).toHaveLength(0)
  })

  it('refuses a non-image up front, on its own line', () => {
    paste(textarea(), [new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' })])
    expect(chips()).toHaveLength(0)
    expect(imageError().style.display).toBe('')
    expect(imageError().textContent).toContain('notes.pdf is not a PNG, JPEG, GIF or WebP image')
    expect(error().style.display).toBe('none')
  })

  it('uploads to the owner, sends the composed directive, then clears the chips', async () => {
    fetch
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ files: [{ name: 'one.png', path: '/srv/.shuttle/attachments/u/abc.png' }] }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ tmux_session: 'w' }) })
    textarea().value = 'what is wrong here?'
    paste(textarea(), [png('one.png')])

    resume().click()
    // Hashing the image is truly asynchronous; wait for the send to land.
    await vi.waitFor(() => expect(chips()).toHaveLength(0))

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://daemon.example/api/v1/attachments',
      'https://daemon.example/api/v1/dispatch',
    ])
    const upload = JSON.parse(fetch.mock.calls[0][1].body)
    expect(upload.fiber).toBe('work/task')
    expect(upload.origin).toBe('cluster')
    expect(upload.attachments).toHaveLength(1)
    const dispatch = JSON.parse(fetch.mock.calls[1][1].body)
    expect(dispatch.user_message).toBe('what is wrong here?\n[Image: /srv/.shuttle/attachments/u/abc.png]')
    expect(dispatch.resume_mode).toBe('previous')
    expect(chips()).toHaveLength(0)
  })

  it('sends nothing and keeps the chips when the upload fails', async () => {
    fetch.mockResolvedValueOnce({
      ok: false, status: 400, text: async () => JSON.stringify({ error: 'at most 8 images per send (got 9)' }),
    })
    paste(textarea(), [png('one.png')])

    resume().click()
    await vi.waitFor(() => expect(resume().disabled).toBe(false))

    expect(fetch).toHaveBeenCalledOnce()
    expect(error().textContent).toBe("Couldn't upload images: at most 8 images per send (got 9)")
    expect(chips()).toHaveLength(1)
    expect(resume().disabled).toBe(false)
  })

  it('keeps a waiting start prompt when an image is admitted or refused', () => {
    mount({ pendingStart: true })
    expect(error().querySelector('.kbn-start-prompt')).not.toBeNull()
    paste(textarea(), [png('one.png')])
    paste(textarea(), [new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' })])
    expect(error().querySelector('.kbn-start-prompt')).not.toBeNull()
    expect(imageError().textContent).toContain('notes.pdf')
    expect(chips()).toHaveLength(1)
  })

  it('starts from the start prompt with the images uploaded and the directory confirmed', async () => {
    mount({ pendingStart: true })
    fetch.mockResolvedValueOnce(uploaded('/srv/.shuttle/attachments/u/abc.png')).mockResolvedValueOnce(dispatched)
    textarea().value = 'begin here'
    paste(textarea(), [png('one.png')])
    const dir = error().querySelector<HTMLInputElement>('.kbn-start-prompt-input')!
    dir.value = '/srv/project'
    dir.dispatchEvent(new Event('input'))
    error().querySelector<HTMLButtonElement>('.kbn-start-prompt button.kbn-ctl-send')!.click()

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(fetch.mock.calls[0][0]).toBe('https://daemon.example/api/v1/attachments')
    const dispatch = JSON.parse(fetch.mock.calls[1][1].body)
    expect(dispatch.project_dir).toBe('/srv/project')
    expect(dispatch.resume_mode).toBe('fresh')
    expect(dispatch.user_message).toBe('begin here\n[Image: /srv/.shuttle/attachments/u/abc.png]')
  })

  it('holds every verb and freezes the chips while a send is in flight', async () => {
    const meeting: MeetingJoinControl = {
      canJoin: () => true, current: () => null, join: vi.fn(async () => ({ error: null, delivered: true })),
    }
    mount({ meeting })
    const upload = defer<unknown>()
    fetch.mockReturnValueOnce(upload.promise)
    paste(textarea(), [png('one.png')])
    resume().click()

    const opener = composer.querySelector<HTMLButtonElement>('.kbn-ctl-meet-btn')!
    expect(fresh().disabled).toBe(true)
    expect(opener.disabled).toBe(true)
    expect(composer.querySelector<HTMLButtonElement>('.kbn-ctl-image-remove')!.disabled).toBe(true)
    paste(textarea(), [png('two.png')])
    expect(chips()).toHaveLength(1)
    expect(imageError().textContent).toBe('Wait for the send to finish before adding images.')

    upload.resolve({ ok: false, status: 500, text: async () => JSON.stringify({ error: 'disk full' }) })
    await vi.waitFor(() => expect(error().textContent).toBe("Couldn't upload images: disk full"))
    expect(fresh().disabled).toBe(false)
    expect(resume().disabled).toBe(false)
    expect(opener.disabled).toBe(false)
    expect(composer.querySelector<HTMLButtonElement>('.kbn-ctl-image-remove')!.disabled).toBe(false)
    expect(chips()).toHaveLength(1)
  })

  it('a meeting keeps text typed during its upload and clears only what it sent', async () => {
    const meeting: MeetingJoinControl = {
      canJoin: () => true,
      current: () => null,
      join: async (_card, _mode, note) => {
        await note()
        return { error: null, delivered: true }
      },
    }
    mount({ meeting })
    const upload = defer<unknown>()
    fetch.mockReturnValueOnce(upload.promise)
    textarea().value = 'first thought'
    paste(textarea(), [png('one.png')])
    composer.querySelector<HTMLButtonElement>('.kbn-ctl-meet-btn')!.click()
    composer.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click()

    textarea().value = 'first thought, and a second'
    upload.resolve(uploaded('/srv/a.png'))
    await vi.waitFor(() => expect(chips()).toHaveLength(0))
    expect(textarea().value).toBe('first thought, and a second')
  })

  it('a meeting with an unchanged note clears it once received, and keeps everything when not received', async () => {
    let delivered = false
    const meeting: MeetingJoinControl = {
      canJoin: () => true,
      current: () => null,
      join: async (_card, _mode, note) => {
        await note()
        return { error: null, delivered }
      },
    }
    mount({ meeting })
    const start = (): void => {
      composer.querySelector<HTMLButtonElement>('.kbn-ctl-meet-btn')!.click()
      composer.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click()
    }
    fetch.mockResolvedValue(uploaded('/srv/a.png'))
    textarea().value = 'note'
    paste(textarea(), [png('one.png')])

    start()
    await vi.waitFor(() => expect(composer.querySelector<HTMLButtonElement>('.kbn-ctl-meet-btn')!.disabled).toBe(false))
    expect(chips()).toHaveLength(1)
    expect(textarea().value).toBe('note')

    delivered = true
    start()
    await vi.waitFor(() => expect(chips()).toHaveLength(0))
    expect(textarea().value).toBe('')
  })

  it('retains a draft and image chips in its owner+uid band across channel switches', () => {
    const task = card({ id: 'work/task', uid: 'task-uid', originId: 'cluster' })
    const firstBand = panel.bandFor(task)
    document.body.append(firstBand.el)
    const input = firstBand.el.querySelector<HTMLTextAreaElement>('textarea')!
    input.value = 'half a thought'
    paste(input, [png('one.png')])

    const otherBand = panel.bandFor(card({ id: 'work/other', uid: 'other-uid', originId: 'cluster' }))
    document.body.append(otherBand.el)
    expect(panel.bandFor(task)).toBe(firstBand)
    expect(firstBand.el.querySelector('textarea')).toBe(input)
    expect(input.value).toBe('half a thought')
    expect(firstBand.el.querySelectorAll('.kbn-ctl-image')).toHaveLength(1)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    expect(panel.bandFor(card({ id: 'work/task', uid: 'task-uid', originId: 'other-host' }))).not.toBe(firstBand)
  })

  it('revokes every thumbnail URL when the dock forgets its card', () => {
    paste(textarea(), [png('one.png'), png('two.png')])
    panel.reset()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:thumb-1')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:thumb-2')
  })
})
