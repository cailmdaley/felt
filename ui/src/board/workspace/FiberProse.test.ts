// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KanbanCard } from '../KanbanTypes.js'
import type { Channel } from './documents.js'
import { resetDocumentResources } from '../documentResources.js'
import { buildFiberProse, installBodyFileLinks, ledeHtml, renderFiberMarkdown, settleBodyFileLink } from './FiberProse.js'

vi.mock('../wikilinks.js', async (original) => {
  const mod = await original<typeof import('../wikilinks.js')>()
  return { ...mod, installWikilinks: vi.fn(async (root, opts) => {
    for (const anchor of root.querySelectorAll('a.kbn-wikilink')) {
      const id = mod.resolveWikilink(anchor.dataset.fiber, [{ id: 'notes/other', name: 'Other' }])
      if (id) anchor.addEventListener('click', () => opts.onOpen(id))
    }
  }) }
})

const card: KanbanCard = {
  id: 'notes/task', uid: 'task', name: 'Task', path: '/fibers/task/task.md',
  originId: 'host-a', status: 'active', createdAt: '', fiberDir: '/fibers/task',
  shuttleProjectDir: '/project', shuttleAgent: 'sol', outcome: 'Outcome $x^2$',
  effectiveHorizon: 'now', drifted: false, isCycle: false, cycleStart: '',
}
const channel: Channel = {
  uid: 'task', owner: 'host-a', name: 'Task', body: 'See [[other]] and [notes](notes.md).\n\n:::{embed} report.html\n:title: Results\n:::\n\nBody $y$.',
  outcome: 'Outcome $x^2$', labels: ['Task', 'Results'],
  documents: [
    { key: 'fiber:host-a:task', owner: 'host-a', path: card.path, name: 'Task', kind: 'fiber', provenance: [] },
    { key: 'host-a:/fibers/task/report.html', owner: 'host-a', path: '/fibers/task/report.html', name: 'report.html', kind: 'html', provenance: [] },
  ],
}
afterEach(() => { vi.unstubAllGlobals(); resetDocumentResources() })

describe('fiber prose', () => {
  it('shares embed removal, outcome math and owner-aware markdown with the modal', () => {
    const rendered = renderFiberMarkdown(channel.body, channel.outcome!, card)
    expect(rendered.attachments).toHaveLength(1)
    expect(rendered.html).not.toContain(':::{embed}')
    expect(rendered.html).toContain('katex')
    expect(rendered.html).toContain('origin=host-a')
    expect(rendered.html).toContain('data-file-path="/fibers/task/notes.md"')
    expect(rendered.html).toContain('data-file-path-alt="/project/notes.md"')
    expect(ledeHtml('')).toBe('')
  })

  it('shows status alone in the header and leaves documents to the tab strip', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    const onFiber = vi.fn(), onFile = vi.fn()
    const pane = buildFiberProse(card, channel, { shuttleBase: '', onFiber, onFile })
    expect(pane.querySelector('header')?.textContent).toBe('In flight')
    expect(pane.querySelector('.ws-prose-status')?.textContent).toBe('In flight')
    expect(pane.querySelector('.ws-prose-agent, .ws-prose-host')).toBeNull()
    expect(pane.querySelector('h1')?.textContent).toBe('Task')
    expect(pane.querySelector('iframe')).toBeNull()
    expect(pane.querySelector('.ws-prose-documents')).toBeNull()
    await Promise.resolve()
    pane.querySelector<HTMLAnchorElement>('a.kbn-wikilink')!.click()
    expect(onFiber).toHaveBeenCalledWith('notes/other')
    pane.querySelector<HTMLAnchorElement>('a[data-file-path]')!.click()
    expect(onFile).toHaveBeenCalledWith('/fibers/task/notes.md', 'notes')
  })

  it('uses the project-directory fallback when the fiber directory has no such file, but not when its owner is unreachable', async () => {
    const pane = document.createElement('div')
    pane.innerHTML = renderFiberMarkdown('[notes](notes.md)', '', card).html
    const link = pane.querySelector<HTMLAnchorElement>('a')!
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ exists: false }))))
    await settleBodyFileLink(link)
    expect(link.dataset.filePath).toBe('/project/notes.md')
    const onFile = vi.fn()
    installBodyFileLinks(pane, onFile)
    link.click()
    expect(onFile).toHaveBeenCalledWith('/project/notes.md', 'notes')

    pane.innerHTML = renderFiberMarkdown('[notes](notes.md)', '', card).html
    resetDocumentResources()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await settleBodyFileLink(pane.querySelector('a')!)
    expect(pane.querySelector<HTMLAnchorElement>('a')!.dataset.filePath).toBe('/fibers/task/notes.md')
  })

  it('does not intercept modified clicks and routes bytes through a configured daemon', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    const onFile = vi.fn()
    const pane = buildFiberProse(card, channel, { shuttleBase: 'https://daemon.example', onFiber: vi.fn(), onFile })
    const link = pane.querySelector<HTMLAnchorElement>('a[data-file-path]')!
    expect(link.href).toContain('https://daemon.example/api/v1/file?')
    expect(link.dataset.fileUrlAlt).toContain('https://daemon.example/api/v1/file?')
    const event = new MouseEvent('click', { ctrlKey: true, bubbles: true, cancelable: true })
    link.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(onFile).not.toHaveBeenCalled()
  })
})
