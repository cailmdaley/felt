// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { ReportChip } from './ReportChip.js'
import { buildChannel } from './documents.js'
import { cacheDocumentTitle } from './DocumentTitles.js'

let chip: ReportChip | undefined
afterEach(() => { chip?.dispose(); document.body.replaceChildren() })
it('names the artifact in a word, titled by its document, with no preview inside', () => {
  const channel = buildChannel({ uid: 'x', owner: 'host', name: 'A task', path: '/task.md', fiberDir: '/', body: '',
    embeds: [{ path: '/report.html', title: 'Measured response' }], sent: [] })
  const doc = channel.documents.find(doc => doc.path === '/report.html')!
  const open = vi.fn()
  chip = new ReportChip(doc, open); document.body.append(chip.el)
  expect(chip.el.title).toBe('Measured response')
  expect(chip.el.querySelector('.ws-report-title')).toBeNull()
  expect(chip.el.textContent).toBe('Artifact')
  expect(chip.el.getAttribute('aria-label')).toBe('Read artifact: Measured response')
  cacheDocumentTitle(doc.key, doc.path, '<title>Validated response</title>')
  expect(chip.el.title).toBe('Validated response')
  expect(chip.el.getAttribute('aria-label')).toBe('Read artifact: Validated response')
  expect(chip.el.textContent).toBe('Artifact')
  expect(chip.el.querySelector('iframe, figure, .ws-thumbnail')).toBeNull()
  chip.el.focus(); expect(document.activeElement).toBe(chip.el)
  chip.el.click(); expect(open).toHaveBeenCalledOnce()
  chip.dispose(); expect(document.querySelector('.ws-report-chip')).toBeNull()
})
