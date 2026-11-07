// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { buildChannel } from './documents.js'
import { SidebarFiles } from './SidebarFiles.js'

const channel = (sent: { path: string; time: number }[], uid = 'task') =>
  buildChannel({ uid, owner: 'host-a', name: 'Task', path: '/notes/task.md', fiberDir: '/notes', body: '', sent })
const keys = (files: SidebarFiles): (string | undefined)[] => [...files.el.querySelectorAll<HTMLElement>('.ws-sidebar-file')].map(row => row.dataset.key)
const six = Array.from({ length: 6 }, (_, i) => ({ path: `/f${i}.png`, time: i + 1 }))

afterEach(() => document.body.replaceChildren())

it('stands hidden with no files', () => {
  const files = new SidebarFiles()
  expect(files.el.hidden).toBe(true)
  files.show(channel([]), '', new Set(), vi.fn())
  expect(files.el.hidden).toBe(true)
})
it('draws each file newest first, marking the open one, and opens one on click', () => {
  const files = new SidebarFiles(), choose = vi.fn()
  files.show(channel([{ path: '/old.png', time: 1 }, { path: '/new.png', time: 2 }]), 'host-a:/old.png', new Set(), choose)
  expect(files.el.hidden).toBe(false)
  expect(keys(files)).toEqual(['host-a:/new.png', 'host-a:/old.png'])
  expect(files.el.querySelector('[aria-current="page"]')?.getAttribute('data-key')).toBe('host-a:/old.png')
  files.el.querySelector<HTMLButtonElement>('.ws-sidebar-file')!.click()
  expect(choose).toHaveBeenCalledExactlyOnceWith('host-a:/new.png')
})
it('marks each new file and counts them in the heading', () => {
  const files = new SidebarFiles(), sent = channel([{ path: '/a.png', time: 1 }, { path: '/b.png', time: 2 }, { path: '/c.png', time: 3 }])
  files.show(sent, '', new Set(), vi.fn())
  expect(files.el.querySelector('h3')?.textContent).toBe('Sent files')
  expect(files.el.querySelector('.ws-sent-new')).toBeNull()
  files.show(sent, '', new Set(['host-a:/a.png', 'host-a:/c.png']), vi.fn())
  expect(files.el.querySelector('h3')?.textContent).toBe('Sent files · 2 new')
  expect([...files.el.querySelectorAll('.ws-sent-new')].map(mark => mark.closest<HTMLElement>('.ws-sidebar-file')?.dataset.key)).toEqual(['host-a:/c.png', 'host-a:/a.png'])
})
it('folds past the newest four, expands in place keeping focus on the toggle, and folds again for another channel', () => {
  const files = new SidebarFiles(); document.body.append(files.el)
  files.show(channel(six), '', new Set(), vi.fn())
  expect(keys(files)).toHaveLength(4)
  expect(keys(files)[0]).toBe('host-a:/f5.png')
  const more = (): HTMLButtonElement => files.el.querySelector<HTMLButtonElement>('.ws-sidebar-files-more')!
  expect(more().textContent).toBe('Show 2 more')
  more().click()
  expect(keys(files)).toHaveLength(6)
  expect(more().textContent).toBe('Show fewer')
  expect(document.activeElement).toBe(more())
  files.show(channel(six, 'other'), '', new Set(), vi.fn())
  expect(keys(files)).toHaveLength(4)
})
it('keeps a focused row focused as files arrive, and takes focus on the open file', () => {
  const files = new SidebarFiles(); document.body.append(files.el)
  files.show(channel([{ path: '/a.png', time: 1 }, { path: '/b.png', time: 2 }]), 'host-a:/a.png', new Set(), vi.fn())
  files.focus()
  expect(document.activeElement?.getAttribute('data-key')).toBe('host-a:/a.png')
  files.show(channel([{ path: '/a.png', time: 1 }, { path: '/b.png', time: 2 }, { path: '/c.png', time: 3 }]), 'host-a:/a.png', new Set(), vi.fn())
  expect(document.activeElement?.getAttribute('data-key')).toBe('host-a:/a.png')
  expect(keys(files)).toHaveLength(3)
})
