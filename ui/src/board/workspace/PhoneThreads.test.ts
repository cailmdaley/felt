// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { ThreadIndex } from '../threads.js'
import { PhoneThreads } from './PhoneThreads.js'
import { PageSheet } from './PageSheet.js'

const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
  card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', path: `${over.id}.md`, ...over })

describe('the phone thread page', () => {
  const feed = [
    thread({ id: 'hub', status: 'active' }),
    thread({ id: 'hub/a', orchestrator: 'hub', status: 'active', ask: { text: 'Which cut?', at: '2026-07-02T12:00:00Z' } }),
    thread({ id: 'hub/b', orchestrator: 'hub', status: 'open' }),
    thread({ id: 'lone', status: 'open' }),
  ]
  const index = new ThreadIndex(feed)
  const phoneThreads = (card: KanbanCard, index: ThreadIndex, open: (card: KanbanCard) => void) => new PhoneThreads().render(card, index, open)

  it('draws the whole family and marks the open row', () => {
    const open = vi.fn()
    const page = phoneThreads(feed[2], index, open)!
    expect([...page.querySelectorAll('.kbn-thread-name')].map(el => el.textContent)).toEqual(['hub', 'hub/a', 'hub/b'])
    expect(page.querySelector('[aria-current="page"] .kbn-thread-name')?.textContent).toBe('hub/b')
    page.querySelector<HTMLElement>('.kbn-thread-row')!.click()
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'hub' }))
    expect(phoneThreads(feed[0], index, open)!.querySelector('[aria-current="page"] .kbn-thread-name')?.textContent).toBe('hub')
  })

  it('retains disclosures and reveals the current archived thread on repaint', () => {
    const root = thread({ id: 'root', status: 'open' })
    const old = thread({ id: 'root/old', orchestrator: 'root', status: 'closed', tempered: true })
    const nested = thread({ id: 'root/old/nested', orchestrator: 'root-old', status: 'closed', tempered: false })
    const deep = thread({ id: 'root/old/nested/deep', orchestrator: 'root-old-nested', status: 'closed', tempered: true })
    const tree = new ThreadIndex([root, old, nested, deep]), phone = new PhoneThreads(), open = vi.fn()
    const fold = (section: HTMLElement, n: number) => section.querySelectorAll<HTMLDetailsElement>('details')[n]
    let page = phone.render(root, tree, open)!
    expect(fold(page, 0).open).toBe(false)
    fold(page, 0).open = true
    page = phone.render(root, tree, open)!
    expect(fold(page, 0).open).toBe(true)
    fold(page, 0).open = false
    page = phone.render(deep, tree, open)!
    expect([...page.querySelectorAll('details')].map(el => el.open)).toEqual([true])
    fold(page, 0).open = false
    page = phone.render(deep, new ThreadIndex([root, old, nested, { ...deep, outcome: 'Changed' }]), open)!
    expect(fold(page, 0).open).toBe(true)
  })

  it('refreshes an open tree without closing folds or losing keyboard focus', () => {
    const root = thread({ id: 'root', status: 'open' })
    const old = thread({ id: 'root/old', orchestrator: 'root', status: 'closed', tempered: true })
    const phone = new PhoneThreads(), sheet = new PageSheet('', vi.fn())
    document.body.append(sheet.el)
    try {
      const first = phone.render(root, new ThreadIndex([root, old]), vi.fn())!
      sheet.updateThreads(first)
      first.querySelector<HTMLDetailsElement>('details')!.open = true
      first.querySelector<HTMLElement>('details .constitution-state-dot')!.focus()
      const next = phone.render(root, new ThreadIndex([root, { ...old, name: 'Renamed' }]), vi.fn())!
      sheet.updateThreads(next)
      expect(next.querySelector<HTMLDetailsElement>('details')!.open).toBe(true)
      expect(document.activeElement).toBe(next.querySelector('details .constitution-state-dot'))
      expect(next.querySelector('details .kbn-thread-name')?.textContent).toBe('Renamed')
    } finally { sheet.dispose() }
  })

  it('draws nothing for a constitution with no family', () => {
    expect(phoneThreads(feed[3], index, vi.fn())).toBeNull()
  })
})
