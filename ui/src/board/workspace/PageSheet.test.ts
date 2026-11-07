// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { buildChannel } from './documents.js'
import { PageSheet } from './PageSheet.js'

const channel = (sent: { path: string; time: number }[]) =>
  buildChannel({ uid: 'task', owner: 'host-a', name: 'Task', path: '/notes/task.md', fiberDir: '/notes', body: '', sent })

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open') } })
})
afterEach(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
  window.history.replaceState(null, '', '/'); document.body.replaceChildren()
})

it('lists the sent files newest first under its own heading and opens one after closing', async () => {
  const choose = vi.fn(), sheet = new PageSheet('', choose), opener = document.createElement('button')
  document.body.append(sheet.el, opener)
  try {
    sheet.update(channel([{ path: '/old.png', time: 1 }, { path: '/new.png', time: 2 }]), '', new Set())
    sheet.show(opener)
    expect(sheet.el.querySelector('h2')?.textContent).toBe('Sent files')
    expect(opener.getAttribute('aria-expanded')).toBe('true')
    const rows = [...sheet.el.querySelectorAll<HTMLButtonElement>('.ws-sent-file')]
    expect(rows.map(row => row.dataset.key)).toEqual(['host-a:/new.png', 'host-a:/old.png'])
    rows[0].click()
    await vi.waitFor(() => expect(choose).toHaveBeenCalledExactlyOnceWith('host-a:/new.png'))
    expect(sheet.isOpen).toBe(false)
    expect(opener.getAttribute('aria-expanded')).toBe('false')
  } finally { sheet.dispose() }
})
it('stays closed with nothing to show, and says so when opened on no files', () => {
  const sheet = new PageSheet('', vi.fn()), opener = document.createElement('button')
  document.body.append(sheet.el)
  try {
    sheet.show(opener)
    expect(sheet.isOpen).toBe(false)
    sheet.update(channel([]), '', new Set())
    sheet.show(opener)
    expect(sheet.el.querySelector('.ws-sent-files p')?.textContent).toBe('No files sent yet.')
  } finally { sheet.dispose() }
})
it('folds past the newest four and expands in place', () => {
  const sheet = new PageSheet('', vi.fn()), opener = document.createElement('button')
  document.body.append(sheet.el)
  try {
    sheet.update(channel(Array.from({ length: 6 }, (_, i) => ({ path: `/f${i}.png`, time: i + 1 }))), '', new Set())
    sheet.show(opener)
    expect(sheet.el.querySelectorAll('.ws-sent-file')).toHaveLength(4)
    sheet.el.querySelector<HTMLButtonElement>('[data-part="sent-files-more"]')!.click()
    expect(sheet.el.querySelectorAll('.ws-sent-file')).toHaveLength(6)
  } finally { sheet.dispose() }
})
