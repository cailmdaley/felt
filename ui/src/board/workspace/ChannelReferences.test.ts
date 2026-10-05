// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { referenceRuntime, referenceTargets, resolveChannelReference, type ReferenceSurface } from './ChannelReferences.js'
import type { WorkspaceDocument } from './documents.js'

const doc = (path: string, owner = 'host-a', kind: WorkspaceDocument['kind'] = 'text'): WorkspaceDocument => ({ key: `${owner}:${path}`, path, owner, kind, name: path.split('/').at(-1)!, provenance: [] })
const source = doc('/channel/report.html', 'host-a', 'html')
const audio = doc('/channel/tone.mp3', 'host-a', 'audio')
const files = [source, audio, doc('/channel/notes.md'), doc('/elsewhere/shared.csv'), doc('/channel/shared.csv'), doc('/channel/notes.md', 'host-b')]
let surface: ReferenceSurface | undefined

afterEach(() => { surface?.dispose(); surface = undefined; document.body.replaceChildren(); vi.useRealTimers() })

describe('channel reference resolution', () => {
  it('uses the source directory for relative paths and channel uniqueness for bare names', () => {
    expect(resolveChannelReference('tone.mp3', source, files)).toBe(audio)
    expect(resolveChannelReference('./tone.mp3', source, files)).toBe(audio)
    expect(resolveChannelReference('../channel/tone.mp3', source, files)).toBe(audio)
    expect(resolveChannelReference('/channel/tone.mp3', source, files)).toBe(audio)
    expect(resolveChannelReference('shared.csv', source, files)).toBeUndefined()
    expect(resolveChannelReference('notes.md', source, files)).toBeUndefined()
    expect(resolveChannelReference('./notes.md', source, files)?.owner).toBe('host-a')
    expect(resolveChannelReference('./tone%2Emp3', source, files)).toBe(audio)
    expect(resolveChannelReference('./tone.mp3', doc('/elsewhere/report.md'), files)).toBeUndefined()
    for (const value of ['https://example.com/tone.mp3', '//example.com/tone.mp3', 'javascript:alert(1)', '#tone.mp3', '%ff', 'bad\nname', 'host-a:/channel/tone.mp3']) expect(resolveChannelReference(value, source, files)).toBeUndefined()
  })

  it('decorates code and local links, selecting only resolved documents with title tooltips', () => {
    document.body.innerHTML = '<p><code>tone.mp3</code> <a href="./notes.md">Notes</a> <code>shared.csv</code><a href="missing">tone.mp3</a></p><a href="https://example.com">tone.mp3</a><div contenteditable><code>tone.mp3</code></div>'
    const intents = vi.fn()
    surface = referenceRuntime(document.body, candidates => surface!.resolve(referenceTargets(candidates, source, files)), intents)
    surface.scan()
    expect(document.querySelectorAll('.ws-channel-reference')).toHaveLength(3)
    const code = document.querySelector('code')!
    expect(code.parentElement?.title).toBe('tone.mp3')
    expect(code.parentElement?.tagName).toBe('A')
    code.click()
    expect(intents).toHaveBeenLastCalledWith('select', 'tone.mp3')
    ;(document.querySelector('a[href="./notes.md"]') as HTMLElement).click()
    expect(intents).toHaveBeenLastCalledWith('select', './notes.md')
    expect(document.querySelector('a[href="https://example.com"]')?.className).toBe('')
    expect(document.querySelector('[contenteditable] code')?.parentElement?.tagName).toBe('DIV')
    surface.scan()
    expect(document.querySelectorAll('.ws-reference-play')).toHaveLength(2)
    expect(document.querySelectorAll('.ws-channel-reference')).toHaveLength(3)
  })

  it('throttles mutation scans, removes stale matches, and gives document handlers first refusal', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<p><code>tone.mp3</code></p>'
    const requests = vi.fn((candidates: string[]) => surface!.resolve(referenceTargets(candidates, source, files)))
    const intents = vi.fn()
    surface = referenceRuntime(document.body, requests, intents)
    surface.scan()
    const code = document.querySelector('code')!
    code.addEventListener('click', event => event.preventDefault())
    code.click()
    expect(intents).not.toHaveBeenCalled()
    const dynamic = document.createElement('code'); dynamic.textContent = './notes.md'
    document.body.append(dynamic)
    await Promise.resolve(); await vi.advanceTimersByTimeAsync(100)
    expect(dynamic.parentElement?.className).toBe('ws-channel-reference')
    expect(requests).toHaveBeenCalledTimes(2)
    code.textContent = 'shared.csv'
    await Promise.resolve(); await vi.advanceTimersByTimeAsync(100)
    expect(code.parentElement?.tagName).toBe('P')
    expect(document.querySelectorAll('.ws-reference-play')).toHaveLength(0)
  })
})
