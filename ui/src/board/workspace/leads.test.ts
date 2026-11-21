import { afterEach, expect, it, vi } from 'vitest'
import { Leads } from './leads.js'
import type { KanbanCard } from '../KanbanTypes.js'

afterEach(() => { vi.unstubAllGlobals() })

it('a lead read asks no further once its reader is gone', async () => {
  let gone = false
  const asked: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    asked.push(new URL(url, 'http://d').searchParams.get('path')!)
    gone = true
    return new Response(JSON.stringify({ exists: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  const card = { id: 'leads-gone', uid: 'leads-gone', originId: 'host-a', fiberDir: '/store/leads-gone' } as KanbanCard
  expect(await new Leads('', () => gone).of(card)).toBeUndefined()
  expect(asked).toStrictEqual(['/store/leads-gone/tapestry.html'])
})
