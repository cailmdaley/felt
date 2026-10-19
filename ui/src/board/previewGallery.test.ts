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
})
