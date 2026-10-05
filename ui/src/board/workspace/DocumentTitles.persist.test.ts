// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const load = async () => { vi.resetModules(); return import('./DocumentTitles.js') }
const stored = new Map<string, string>()
beforeEach(() => {
  stored.clear()
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('remembered titles', () => {
  it('recalls a declared title from an earlier visit, and only a fresh read makes it current', async () => {
    vi.useFakeTimers()
    let titles = await load()
    titles.cacheDocumentTitle('host:/r/report.html', '/r/report.html', '<title>The report</title>', 'etag-1')
    titles.cacheDocumentTitle('host:/r/untitled.html', '/r/untitled.html', '<p>no title</p>', 'etag-2')
    vi.advanceTimersByTime(500)
    expect(JSON.parse(localStorage.getItem(titles.TITLE_STORAGE)!)).toEqual([['host:/r/report.html', 'The report', 'etag-1']])
    titles = await load()
    expect(titles.declaredTitle('host:/r/report.html')?.title).toBe('The report')
    expect(titles.titleIsCurrent('host:/r/report.html')).toBe(false)
    const heard = vi.fn()
    titles.watchDocumentTitles(heard)
    titles.cacheDocumentTitle('host:/r/report.html', '/r/report.html', '<title>The report</title>', 'etag-1')
    expect(titles.titleIsCurrent('host:/r/report.html')).toBe(true)
    expect(heard).not.toHaveBeenCalled()
    titles.cacheDocumentTitle('host:/r/report.html', '/r/report.html', '<title>The revised report</title>', 'etag-3')
    expect(heard).toHaveBeenCalledWith('host:/r/report.html')
  })

  it('keeps only the most recently used titles', async () => {
    vi.useFakeTimers()
    const titles = await load()
    for (let i = 0; i < titles.TITLE_STORAGE_LIMIT + 5; i++) titles.cacheDocumentTitle(`k${i}`, `/d${i}.md`, `# Title ${i}`, `e${i}`)
    titles.declaredTitle('k0')
    vi.advanceTimersByTime(500)
    const stored: string[][] = JSON.parse(localStorage.getItem(titles.TITLE_STORAGE)!)
    expect(stored).toHaveLength(titles.TITLE_STORAGE_LIMIT)
    expect(stored.at(-1)?.[0]).toBe('k0')
    expect(stored.some(entry => entry[0] === 'k1')).toBe(false)
  })

  it('works without storage', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } })
    const titles = await load()
    expect(titles.cacheDocumentTitle('k', '/d.md', '# Still named', 'e').title).toBe('Still named')
    expect(() => vi.advanceTimersByTime(500)).not.toThrow()
    expect(titles.declaredTitle('k')?.title).toBe('Still named')
  })
})
