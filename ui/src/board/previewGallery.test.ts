// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { buildSendGallery } from './previewGallery.js'
import type { FiberSend } from './fiberSends.js'

const send: FiberSend = { key: 'host:/report.html', fullPath: '/report.html', basename: 'report.html', timestamp: 1, owner: 'host' }

describe('send gallery clear control', () => {
  it('invokes clear from its quiet button without opening a file', () => {
    const clear = vi.fn()
    const open = vi.fn()
    const gallery = buildSendGallery([send], { shuttleBase: 'http://daemon', open, clear })!
    const button = gallery.el.querySelector<HTMLButtonElement>('.kbn-preview-gallery-clear')!
    expect(button.textContent).toBe('Clear')
    button.click()
    expect(clear).toHaveBeenCalledOnce()
    expect(open).not.toHaveBeenCalled()
    gallery.dispose()
  })

  it('disables Clear while the request is pending', async () => {
    let finish!: () => void
    const clear = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const gallery = buildSendGallery([send], { shuttleBase: '', open: vi.fn(), clear })!
    const button = gallery.el.querySelector<HTMLButtonElement>('.kbn-preview-gallery-clear')!
    button.click()
    button.click()
    expect(button.disabled).toBe(true)
    expect(clear).toHaveBeenCalledOnce()
    finish()
    await Promise.resolve()
    expect(button.disabled).toBe(false)
    gallery.dispose()
  })
})
