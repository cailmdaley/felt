// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { buildSendGallery } from './previewGallery.js'
import type { FiberSend } from './fiberSends.js'

const send: FiberSend = { key: 'host:/report.html', fullPath: '/report.html', basename: 'report.html', timestamp: 1, owner: 'host' }

describe('send gallery clear control', () => {
  it('dismisses a sent tile optimistically without opening it or nesting buttons', async () => {
    let finish!: () => void
    const dismiss = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const open = vi.fn()
    const gallery = buildSendGallery([send], { shuttleBase: '', open, dismiss })!
    const button = gallery.el.querySelector<HTMLButtonElement>('[aria-label="Dismiss report.html"]')!
    expect(button.tabIndex).toBe(0)
    expect(button.closest('.kbn-preview-send')).toBeNull()
    button.click()
    button.click()
    expect(dismiss).toHaveBeenCalledExactlyOnceWith(send)
    expect(button.disabled).toBe(true)
    expect(button.parentElement!.hidden).toBe(true)
    expect(open).not.toHaveBeenCalled()
    finish()
    await Promise.resolve()
    expect(button.parentElement!.hidden).toBe(true)
    gallery.dispose()
  })

  it('keeps keyboard focus on the next file across a gallery rebuild', async () => {
    const next: FiberSend = { ...send, key: 'host:/next.html', fullPath: '/next.html', basename: 'next.html' }
    const panel = document.createElement('div')
    panel.className = 'kbn-preview'
    document.body.append(panel)
    let replacement!: ReturnType<typeof buildSendGallery>
    const gallery = buildSendGallery([send, next], { shuttleBase: '', open: vi.fn(), dismiss: async () => {
      replacement = buildSendGallery([next], { shuttleBase: '', open: vi.fn() })!
      gallery.el.replaceWith(replacement.el)
    } })!
    panel.append(gallery.el)
    const button = gallery.el.querySelector<HTMLButtonElement>('.kbn-preview-send-dismiss')!
    button.focus()
    button.click()
    expect(document.activeElement).toBe(panel)
    await Promise.resolve()
    expect(document.activeElement).toBe(replacement!.el.querySelector('.kbn-preview-send'))
    gallery.dispose()
    replacement!.dispose()
    panel.remove()
  })

  it('restores a tile and reports a failed dismissal visibly', async () => {
    const dismiss = vi.fn().mockRejectedValue(new Error('host unavailable'))
    const gallery = buildSendGallery([send], { shuttleBase: '', open: vi.fn(), dismiss })!
    document.body.append(gallery.el)
    const button = gallery.el.querySelector<HTMLButtonElement>('.kbn-preview-send-dismiss')!
    button.click()
    await Promise.resolve()
    expect(button.parentElement!.hidden).toBe(false)
    expect(button.disabled).toBe(false)
    expect(gallery.el.querySelector<HTMLElement>('[role="alert"]')!.hidden).toBe(false)
    expect(gallery.el.querySelector('[role="alert"]')!.textContent).toContain('host unavailable')
    expect(document.activeElement).toBe(button)
    gallery.dispose()
    gallery.el.remove()
  })

  it('offers no dismissal for body-only embeds but does for embeds that were sent', () => {
    const gallery = buildSendGallery([
      { ...send, embedded: true, timestamp: 0 },
      { ...send, fullPath: '/sent.html', basename: 'sent.html', embedded: true },
    ], { shuttleBase: '', open: vi.fn(), dismiss: vi.fn() })!
    const buttons = gallery.el.querySelectorAll('.kbn-preview-send-dismiss')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].getAttribute('aria-label')).toBe('Dismiss sent.html')
    gallery.dispose()
  })

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
