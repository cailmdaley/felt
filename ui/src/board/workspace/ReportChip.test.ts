// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { ReportChip } from './ReportChip.js'
import { buildChannel } from './documents.js'
import { cacheDocumentTitle } from './DocumentTitles.js'

vi.mock('./Thumbnail.js', () => ({ Thumbnail: class {
  el = document.createElement('span')
  dispose = vi.fn()
} }))
let chip: ReportChip | undefined
afterEach(() => { chip?.dispose(); document.body.replaceChildren() })
it('keeps a titled thumbnail as one focusable report entry point without a live inset', () => {
  const channel = buildChannel({ uid: 'x', owner: 'host', name: 'A task', path: '/task.md', fiberDir: '/', body: '',
    embeds: [{ path: '/report.html', title: 'Measured response' }], sent: [] })
  const doc = channel.documents.find(doc => doc.path === '/report.html')!
  const open = vi.fn()
  chip = new ReportChip('', doc, open); document.body.append(chip.el)
  expect(chip.el.title).toBe('Measured response')
  expect(chip.el.querySelector('.ws-report-title')).toBeNull()
  expect(chip.el.textContent).toBe('Report')
  expect(chip.el.getAttribute('aria-label')).toBe('Read artifact: Measured response')
  cacheDocumentTitle(doc.key, doc.path, '<title>Validated response</title>')
  expect(chip.el.title).toBe('Validated response')
  expect(chip.el.getAttribute('aria-label')).toBe('Read artifact: Validated response')
  expect(chip.el.textContent).toBe('Report')
  expect(chip.el.querySelector('iframe, figure')).toBeNull()
  chip.el.focus(); expect(document.activeElement).toBe(chip.el)
  chip.el.click(); expect(open).toHaveBeenCalledOnce()
  chip.dispose(); expect(document.querySelector('.ws-report-chip')).toBeNull()
})
