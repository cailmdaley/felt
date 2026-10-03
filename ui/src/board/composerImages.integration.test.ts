// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FiberDetailModal } from './FiberDetailModal'
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

function paste(target: HTMLElement, files: File[]): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { files, items: [] } })
  target.dispatchEvent(event)
  return event
}

let composer: HTMLElement
let fetch: ReturnType<typeof vi.fn>
let panel: FiberDetailModal

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  let n = 0
  URL.createObjectURL = vi.fn(() => `blob:thumb-${++n}`)
  URL.revokeObjectURL = vi.fn()
  fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  panel = new FiberDetailModal('https://daemon.example', vi.fn())
  vi.spyOn(panel, 'close').mockImplementation(() => {})
  const build = (panel as unknown as {
    buildComposer(c: ReturnType<typeof card>, swallow: (el: HTMLElement) => void): HTMLElement
  }).buildComposer.bind(panel)
  composer = build(card({ id: 'work/task', originId: 'cluster' }), () => {})
  document.body.append(composer)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const textarea = (): HTMLTextAreaElement => composer.querySelector('textarea')!
const chips = (): HTMLElement[] => [...composer.querySelectorAll<HTMLElement>('.kbn-ctl-image')]
const error = (): HTMLElement => composer.querySelector<HTMLElement>('.kbn-detail-error')!
const resume = (): HTMLButtonElement =>
  [...composer.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Resume')!

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

  it('refuses a non-image up front, in the error line', () => {
    paste(textarea(), [new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' })])
    expect(chips()).toHaveLength(0)
    expect(error().style.display).toBe('')
    expect(error().textContent).toContain('notes.pdf is not a PNG, JPEG, GIF or WebP image')
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
})
