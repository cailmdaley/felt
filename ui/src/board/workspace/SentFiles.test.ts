// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { buildChannel, docKey } from './documents.js'
import { DocumentSeen } from './DocumentSeen.js'
import { compactStamp, sentFiles } from './SentFiles.js'

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('lists only sent files, newest first, with dates and exact owner-aware selection', () => {
  const channel = buildChannel({ uid: 'task', owner: 'host-a', name: 'Task', path: '/notes/task.md', fiberDir: '/notes', body: '',
    embeds: [{ path: 'unshared.html' }], sent: [{ path: '/old.png', time: 1 }, { path: '/new.png', owner: 'host-b', time: 2 }] })
  const choose = vi.fn(), key = docKey('host-b', '/new.png', 'host-a')
  const list = sentFiles(channel, '', new Set([key]), choose)
  const rows = [...list.querySelectorAll<HTMLButtonElement>('.ws-sent-file')]
  expect(rows.map(row => row.dataset.key)).toEqual([key, 'host-a:/old.png'])
  expect(rows[0].querySelector('time')?.dateTime).toBe(new Date(2).toISOString())
  expect(rows[0].querySelector('.ws-sent-new')?.textContent).toBe('new')
  expect(rows[1].querySelector('.ws-sent-new')).toBeNull()
  rows[0].click(); expect(choose).toHaveBeenCalledExactlyOnceWith(key)
})
it('marks a resend after the last look and clears it only when that file is read', () => {
  vi.spyOn(Date, 'now').mockReturnValue(100)
  const input = { uid: 'task', owner: 'host-a', name: 'Task', path: '/notes/task.md', fiberDir: '/notes', body: '' }
  const seen = new DocumentSeen(), first = buildChannel({ ...input, sent: [{ path: '/plot.png', time: 1 }] })
  const key = 'host-a:/plot.png'
  expect(seen.observe(first, first.documents[0].key)).toEqual(new Set())
  const updated = buildChannel({ ...input, previous: first, sent: [{ path: '/plot.png', time: 101 }] })
  const fresh = seen.observe(updated, first.documents[0].key)
  expect(sentFiles(updated, '', fresh, vi.fn()).querySelector('.ws-sent-new')).not.toBeNull()
  expect(seen.observe(updated, key).has(key)).toBe(false)
  expect(seen.observe(updated, first.documents[0].key).has(key)).toBe(false)
})
it('stamps a narrow column compactly: the time today, the date this year, the year otherwise', () => {
  const now = new Date(2026, 9, 27, 15, 0).getTime()
  expect(compactStamp(new Date(2026, 9, 27, 9, 5).getTime(), now)).toBe(new Date(2026, 9, 27, 9, 5).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))
  expect(compactStamp(new Date(2026, 2, 3, 9, 5).getTime(), now)).toBe(new Date(2026, 2, 3).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
  expect(compactStamp(new Date(2025, 2, 3).getTime(), now)).toMatch(/2025/)
})
