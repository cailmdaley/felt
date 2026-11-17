// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { Item } from '../channels.js'
import { card } from '../testFixtures.js'
import { groups, post } from './post.js'

const now = 1_800_000_000_000
const item = (over: Partial<Item> = {}): Item => ({ kind: 'post', id: 'b1', card: card({ id: 'cmbx/tsz', uid: 'T', name: 'tSZ' }), at: now - 120_000, arrived: now, text: 'At **9σ**.', files: [], waiting: false, ...over })

describe('post', () => {
  it('draws who, what kind and when, then its words; a click outside its buttons opens its thread', () => {
    const open = vi.fn(), dot = document.createElement('button')
    const row = post(item(), { now, dot, open })
    expect([row.dataset.kind, row.dataset.slug, row.dataset.fiber, row.firstElementChild === dot]).toStrictEqual(['post', 'tsz', 'T', true])
    expect([...row.querySelectorAll('.kbn-ch-item-head > *')].map(part => part.textContent)).toStrictEqual(['tsz', '2m ago'])
    expect(row.querySelector('.kbn-ch-item-text strong')!.textContent).toBe('9σ')
    row.querySelector<HTMLElement>('.kbn-ch-item-text')!.click()
    expect(open).toHaveBeenCalledTimes(1)
  })
  it('names its office and what it asks, and carries its clear and its previews', () => {
    const clear = document.createElement('button'), previews = document.createElement('div')
    const asked = item({ kind: 'ask', line: 'T:0', waiting: true, card: card({ id: 'cmbx/tsz', uid: 'T', name: 'tSZ', shuttleRole: 'cmbx-expert' }) })
    const row = post(asked, { now, dot: document.createElement('button'), open: () => {}, clear, previews })
    expect([...row.querySelectorAll('.kbn-ch-item-head > *')].map(part => part.textContent)).toStrictEqual(['tsz', 'cmbx-expert', 'asks', '2m ago', ''])
    expect([row.dataset.line, row.hasAttribute('data-waiting'), row.querySelector('.kbn-ch-who')!.getAttribute('aria-label')]).toStrictEqual(['T:0', true, 'tsz asks'])
    expect([row.querySelector('.kbn-ch-item-head')!.lastElementChild === clear, row.querySelector('.kbn-ch-item-body')!.lastElementChild === previews]).toStrictEqual([true, true])
  })
})

describe('grouping', () => {
  const earlier = item({ id: 'b0', at: now - 240_000 })
  it('groups a line under the one before it from the same thread within five minutes, unless it asks something', () => {
    expect([groups(earlier, item()), groups(item({ id: 'b0', at: now - 500_000 }), item()), groups(item({ id: 'b0', card: card({ id: 'other' }) }), item()), groups(earlier, item({ kind: 'ask' })), groups(undefined, item())])
      .toStrictEqual([true, false, false, false, false])
  })
  it('draws a grouped line without a head of its own, its age kept for hover', () => {
    const row = post(item(), { now, dot: document.createElement('button'), open: () => {}, grouped: true })
    expect([row.hasAttribute('data-grouped'), row.querySelector('.kbn-ch-age')!.textContent]).toStrictEqual([true, '2m ago'])
  })
})
