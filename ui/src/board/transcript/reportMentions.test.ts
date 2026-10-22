// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { mentionRuntime } from '../workspace/bodyLinks.js'
import { reportMentionRuntime } from './reportMentions.js'
import { connectDocumentFrame } from '../workspace/DocumentBridge.js'

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren() })
it('requests report candidates in complete bounded batches rather than truncating the model', async () => {
  document.body.textContent = Array.from({ length: 502 }, (_, i) => `work/${i}`).join(' ')
  const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
  const dispose = reportMentionRuntime(mentionRuntime, '', { count: 500, length: 256 }, () => true)
  window.dispatchEvent(new MessageEvent('message', { source: window.parent, data: { protocol: 'shuttle-constitution-mentions', type: 'scan' } }))
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2))
  const requests = post.mock.calls.map(([message]) => message)
  expect(requests.map(message => message.candidates.length)).toEqual([500, 2])
  expect(requests[0]).toMatchObject({ reset: true, done: false })
  expect(requests[1]).toMatchObject({ reset: false, done: true })
  expect(requests.flatMap(message => message.candidates)).toContain('work/501')
  dispose()
})
it('exposes only parent-commanded frame activity, not a child assertion', () => {
  const frame = document.createElement('iframe'); document.body.append(frame)
  const bridge = connectDocumentFrame(frame, vi.fn())
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {})
  expect(bridge.active).toBe(false)
  window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { protocol: 'shuttle-document', version: 1, type: 'active', payload: { active: true } } }))
  expect(bridge.active).toBe(false)
  bridge.command('active', { active: true }); expect(bridge.active).toBe(true)
  bridge.command('active', { active: false }); expect(bridge.active).toBe(false)
  bridge.dispose()
})
