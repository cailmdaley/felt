// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { RexFocus, type RexFocusEvent } from './rexFocus'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

class Source {
  static all: Source[] = []
  static readonly CLOSED = 2
  readyState = 1
  closed = false
  listeners = new Map<string, (event: Event) => void>()
  url: string
  constructor(url: string) { this.url = url; Source.all.push(this) }
  addEventListener(type: string, fn: (event: Event) => void): void { this.listeners.set(type, fn) }
  close(): void { this.closed = true }
}

it('hands on each worker Rex moves to, and reopens a refused stream until disposed', () => {
  vi.useFakeTimers()
  Source.all = []
  vi.stubGlobal('EventSource', Source)
  const moved: RexFocusEvent[] = [], focus = new RexFocus('http://hub', event => moved.push(event))
  focus.mount()
  const [first] = Source.all
  expect(first.url).toBe('http://hub/api/v1/rex/focus')
  const event = { fiber_id: 'uid', origin: 'fir', name: 'Worker' }
  first.listeners.get('focus')!(new MessageEvent('focus', { data: JSON.stringify(event) }))
  expect(moved).toEqual([event])

  first.readyState = Source.CLOSED
  first.listeners.get('error')!(new Event('error'))
  vi.advanceTimersByTime(5_000)
  expect(Source.all).toHaveLength(2)
  focus.dispose()
  expect(Source.all[1].closed).toBe(true)
  Source.all[1].readyState = Source.CLOSED
  Source.all[1].listeners.get('error')!(new Event('error'))
  vi.advanceTimersByTime(5_000)
  expect(Source.all).toHaveLength(2)
})
