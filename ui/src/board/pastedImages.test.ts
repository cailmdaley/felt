import { afterEach, describe, expect, it, vi } from 'vitest'
import { FiberDetailModal } from './FiberDetailModal.js'
import {
  MAX_PASTED_IMAGES,
  MAX_PASTED_IMAGE_BYTES,
  MAX_PASTED_TOTAL_BYTES,
  PastedImages,
  bytesToBase64,
  composeDirective,
  filesFromTransfer,
  pastedImageFiles,
  transferHasFiles,
  uploadPastedImages,
} from './pastedImages.js'
import { card } from './testFixtures.js'

afterEach(() => vi.unstubAllGlobals())

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
// Computed independently of the code under test (Python's hashlib and base64).
const PNG_SHA256 = '7f47b756761a46e6d4a4d96f0d8a4448f8449235009d1f3ad1493f5c773c19e8'
const PNG_BASE64 = 'iVBORw0KGgoBAgM='

function file(name: string, type: string, bytes: Uint8Array | number = PNG): File {
  const body = typeof bytes === 'number' ? new Uint8Array(bytes) : bytes
  return new File([body as unknown as BlobPart], name, { type })
}

/** A Blob that claims `size` bytes without allocating them. */
function sized(name: string, type: string, size: number): File {
  return { name, type, size } as unknown as File
}

describe('PastedImages limits', () => {
  it('admits png, jpeg, gif and webp and keeps their order', () => {
    const images = new PastedImages()
    const refused = images.add([
      file('a.png', 'image/png'),
      file('b.jpg', 'image/jpeg'),
      file('c.gif', 'image/gif'),
      file('d.webp', 'image/webp'),
    ])
    expect(refused).toBeNull()
    expect(images.list.map((i) => i.name)).toEqual(['a.png', 'b.jpg', 'c.gif', 'd.webp'])
  })

  it('refuses other types, naming the file', () => {
    const images = new PastedImages()
    const refused = images.add([file('notes.pdf', 'application/pdf'), file('ok.png', 'image/png'), file('x.svg', 'image/svg+xml')])
    expect(images.size).toBe(1)
    expect(refused).toContain('notes.pdf is not a PNG, JPEG, GIF or WebP image')
    expect(refused).toContain('x.svg')
  })

  it('refuses an image over the per-image limit', () => {
    const images = new PastedImages()
    const refused = images.add([sized('huge.png', 'image/png', MAX_PASTED_IMAGE_BYTES + 1)])
    expect(images.size).toBe(0)
    expect(refused).toMatch(/huge\.png is 10\.1 MB; the limit is 10 MB per image/)
  })

  it('admits an image exactly at the per-image limit', () => {
    const images = new PastedImages()
    expect(images.add([sized('edge.png', 'image/png', MAX_PASTED_IMAGE_BYTES)])).toBeNull()
  })

  it('stops at the per-send count', () => {
    const images = new PastedImages()
    const many = Array.from({ length: MAX_PASTED_IMAGES + 2 }, (_, i) => file(`${i}.png`, 'image/png'))
    const refused = images.add(many)
    expect(images.size).toBe(MAX_PASTED_IMAGES)
    expect(refused).toContain(`would exceed ${MAX_PASTED_IMAGES} images per send`)
  })

  it('stops at the per-send total', () => {
    const images = new PastedImages()
    const each = MAX_PASTED_IMAGE_BYTES - 1
    const refused = images.add([1, 2, 3].map((n) => sized(`${n}.png`, 'image/png', each)))
    expect(images.size).toBe(Math.floor(MAX_PASTED_TOTAL_BYTES / each))
    expect(refused).toContain('would bring the send past 25 MB')
  })

  it('names an unnamed clipboard bitmap, and removes and clears', () => {
    const images = new PastedImages()
    images.add([new Blob([PNG as unknown as BlobPart], { type: 'image/png' }), file('b.png', 'image/png')])
    expect(images.list[0].name).toBe('image 1')
    images.remove(images.list[0].id)
    expect(images.list.map((i) => i.name)).toEqual(['b.png'])
    images.clear()
    expect(images.size).toBe(0)
  })
})

describe('transfers', () => {
  it('reads files, falling back to file items', () => {
    const a = file('a.png', 'image/png')
    expect(filesFromTransfer({ files: [a] as unknown as FileList, items: [] as unknown as DataTransferItemList })).toEqual([a])
    const items = [
      { kind: 'string', getAsFile: () => null },
      { kind: 'file', getAsFile: () => a },
    ]
    expect(filesFromTransfer({ files: [] as unknown as FileList, items: items as unknown as DataTransferItemList })).toEqual([a])
    expect(filesFromTransfer(null)).toEqual([])
  })

  it('treats a clipboard with text as a text paste, attaching nothing', () => {
    const a = file('a.png', 'image/png')
    const clip = (text: string) => ({
      files: [a] as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    })
    expect(pastedImageFiles(clip('a copied paragraph'))).toEqual([])
    expect(pastedImageFiles(clip('  \n '))).toEqual([a])
    expect(pastedImageFiles(clip(''))).toEqual([a])
    expect(pastedImageFiles(null)).toEqual([])
  })

  it('tells a file drag from a text drag', () => {
    expect(transferHasFiles({ types: ['Files'] })).toBe(true)
    expect(transferHasFiles({ types: ['text/plain'] })).toBe(false)
    expect(transferHasFiles(null)).toBe(false)
  })
})

describe('composeDirective', () => {
  it('appends one image line per path after the typed text', () => {
    expect(composeDirective('  look at these  ', ['/h/.shuttle/attachments/u/a.png', '/h/b.jpg'])).toBe(
      'look at these\n[Image: /h/.shuttle/attachments/u/a.png]\n[Image: /h/b.jpg]',
    )
  })

  it('carries images alone when nothing was typed, and text alone without images', () => {
    expect(composeDirective('', ['/x.png'])).toBe('[Image: /x.png]')
    expect(composeDirective('just text', [])).toBe('just text')
  })
})

describe('uploadPastedImages', () => {
  it('posts each image base64 with its sha256 to the owner and returns the paths', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ files: [{ name: 'a.png', path: '/remote/attachments/u/abc.png', sha256: 'x', size: 11 }] }),
    })
    vi.stubGlobal('fetch', fetch)
    const images = new PastedImages()
    images.add([file('a.png', 'image/png')])

    const paths = await uploadPastedImages('http://daemon', card({ id: 'work/task', originId: 'cluster' }), images.list)

    expect(paths).toEqual(['/remote/attachments/u/abc.png'])
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('http://daemon/api/v1/attachments')
    const body = JSON.parse(init.body)
    expect(body.fiber).toBe('work/task')
    expect(body.origin).toBe('cluster')
    expect(body.attachments).toEqual([
      {
        name: 'a.png',
        mime: 'image/png',
        data: PNG_BASE64,
        sha256: PNG_SHA256,
      },
    ])
  })

  it("throws the daemon's error", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: 'image 1: sha256 does not match the data' }),
    }))
    const images = new PastedImages()
    images.add([file('a.png', 'image/png')])
    await expect(uploadPastedImages('http://daemon', card({ id: 'w' }), images.list)).rejects.toThrow(
      "Couldn't upload images: image 1: sha256 does not match the data",
    )
  })

  it('base64 survives a buffer larger than one chunk', () => {
    const big = new Uint8Array(100_000).map((_, i) => i % 251)
    const decoded = Uint8Array.from(atob(bytesToBase64(big)), (c) => c.charCodeAt(0))
    expect(decoded).toEqual(big)
    expect(bytesToBase64(PNG)).toBe(PNG_BASE64)
  })
})

describe('a send with images', () => {
  type Requeue = {
    runRequeue: (c: ReturnType<typeof card>, directive: string | (() => Promise<string>), mode: 'fresh' | 'previous',
      btn: HTMLButtonElement, error: HTMLElement) => Promise<boolean>
  }
  const btn = (): HTMLButtonElement => ({ textContent: 'Resume', disabled: false }) as HTMLButtonElement
  const errorEl = (): HTMLElement => ({ style: { display: 'none' }, textContent: '' }) as unknown as HTMLElement

  it('uploads first, then dispatches the composed directive', async () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) })
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ files: [{ path: '/h/a.png' }] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ tmux_session: 'w' }) })
    vi.stubGlobal('fetch', fetch)
    const panel = new FiberDetailModal('http://daemon', vi.fn())
    vi.spyOn(panel, 'close').mockImplementation(() => {})
    const images = new PastedImages()
    images.add([file('a.png', 'image/png')])
    const target = card({ id: 'work/task', originId: 'local' })
    const compose = async (): Promise<string> =>
      composeDirective('see this', await uploadPastedImages('http://daemon', target, images.list))

    const ok = await (panel as unknown as Requeue).runRequeue(target, compose, 'previous', btn(), errorEl())

    expect(ok).toBe(true)
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'http://daemon/api/v1/attachments',
      'http://daemon/api/v1/dispatch',
    ])
    expect(JSON.parse(fetch.mock.calls[1][1].body).user_message).toBe('see this\n[Image: /h/a.png]')
  })

  it('sends nothing when the upload fails, and says why', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false, status: 404, text: async () => JSON.stringify({ error: 'fiber not found: work/task' }),
    })
    vi.stubGlobal('fetch', fetch)
    const panel = new FiberDetailModal('http://daemon', vi.fn())
    const images = new PastedImages()
    images.add([file('a.png', 'image/png')])
    const target = card({ id: 'work/task' })
    const compose = async (): Promise<string> =>
      composeDirective('', await uploadPastedImages('http://daemon', target, images.list))
    const button = btn()
    const err = errorEl()

    const ok = await (panel as unknown as Requeue).runRequeue(target, compose, 'previous', button, err)

    expect(ok).toBe(false)
    expect(fetch).toHaveBeenCalledOnce()
    expect(err.textContent).toBe("Couldn't upload images: fiber not found: work/task")
    expect(err.style.display).toBe('')
    expect(button.disabled).toBe(false)
    expect(button.textContent).toBe('Resume')
  })
})
