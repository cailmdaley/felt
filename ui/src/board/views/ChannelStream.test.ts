// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { BoardRecord } from '../boardFeed.js'
import { composeStream, runningIn, type Channel } from '../channels.js'
import { card } from '../testFixtures.js'
import { ChannelStream } from './ChannelStream.js'

const streams: ChannelStream[] = []
afterEach(() => {
  for (const s of streams) s.dispose()
  streams.length = 0
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

it('ChannelStream renders posts, asks, stations, margin ink, and dispatches openCard/clearLine callbacks standalone', () => {
  const now = Date.now()
  const chair = card({ id: 'fam', uid: 'F', name: 'Family chair', status: 'active', workerState: 'running', runtimePhase: 'waiting', shuttleKind: 'oneshot', sessionUuid: 's1' })
  const worker = card({ id: 'fam/sub', uid: 'S', name: 'Sub worker', orchestrator: 'F', status: 'active', workerState: 'running', runtimePhase: 'working', shuttleKind: 'oneshot', sessionUuid: 's2', ask: { text: 'Use 5σ?', at: new Date(now - 2_000).toISOString() } })
  const channel: Channel = {
    key: 'family:F', name: 'fam', title: 'Family chair', misc: false, seat: chair, spelling: '',
    declarers: [], members: [chair, worker], heads: [chair], everyone: [chair, worker], families: ['F'],
    newest: 0, waiting: true, active: now, pinned: false, hidden: 0, listed: true,
  }
  const records: BoardRecord[] = [
    { id: 'r1', kind: 'post', fiber: 'S', by: { fiber: 'S' }, to: { label: 'human' }, text: 'First measurement done.', timestamp: now - 10_000, originName: 'local' },
  ]
  const whole = composeStream({
    channel, records, files: [], waits: new Map(), launches: c => c.uid === 'S' ? [now - 20_000] : [],
    cleared: new Map(), now, reachMs: 14 * 86_400_000,
  })

  const openCard = vi.fn(), openFile = vi.fn(), clearLine = vi.fn(), onRedraw = vi.fn()
  const stream = new ChannelStream({
    shuttleBase: '',
    awake: () => true,
    openCard,
    openFile,
    lead: async () => undefined,
    clearLine,
    onRedraw,
  })
  streams.push(stream)
  document.body.append(stream.el)

  stream.render({
    key: channel.key,
    label: '#fam',
    whole,
    everyone: channel.everyone,
    running: runningIn(channel),
    waits: new Map(),
    records,
    launches: c => c.uid === 'S' ? [now - 20_000] : [],
    parentOf: () => undefined,
    now,
  })

  const items = [...stream.el.querySelectorAll<HTMLElement>('.kbn-ch-item')]
  expect(items.map(el => el.dataset.kind)).toStrictEqual(['post', 'ask'])
  expect(stream.el.querySelector('.kbn-ch-margin svg')).not.toBeNull()
  expect(stream.el.querySelector('.kbn-ch-count-n')!.textContent).toBe('2')

  items[0]!.querySelector<HTMLButtonElement>('[data-item]')!.click()
  expect(openCard).toHaveBeenCalledWith(worker, 'item:r1')

  items[0]!.querySelector<HTMLButtonElement>('.kbn-ch-clear')!.click()
  expect(clearLine).toHaveBeenCalledTimes(1)
})
