// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { buildChannel } from './documents.js'
import { PageSheet } from './PageSheet.js'

it('shows the sent-files heading exactly when the open sheet also has threads', () => {
  const sheet = new PageSheet('', vi.fn())
  const channel = buildChannel({ uid: 'task', owner: 'host-a', name: 'Task', path: '/notes/task.md', fiberDir: '/notes', body: '', sent: [{ path: '/plot.png', time: 1 }] })
  try {
    sheet.el.setAttribute('open', '')
    sheet.updateThreads(null)
    sheet.update(channel, '', new Set())
    const heading = () => sheet.el.querySelector<HTMLElement>('.ws-sent-files h3')!
    expect(heading().hidden).toBe(true)
    sheet.updateThreads(document.createElement('section'))
    expect(heading().hidden).toBe(false)
    sheet.updateThreads(null)
    expect(heading().hidden).toBe(true)
  } finally { sheet.el.removeAttribute('open'); sheet.dispose() }
})
