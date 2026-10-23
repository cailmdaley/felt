// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeRecord } from './records.js'
import { TranscriptBand } from './TranscriptBand.js'
import source from './fixtures/tool-result-images.jsonl?raw'

const lines = source.trim().split('\n').map(line => JSON.parse(line) as unknown)
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('images a tool returned', () => {
  it('keeps each harness\'s image payload on its result, undecoded', () => {
    const results = lines.flatMap(normalizeRecord).filter(entry => entry.kind === 'result')
    expect(results.map(entry => entry.kind === 'result' && entry.pictures)).toEqual([
      [{ mediaType: 'image/png', data: PNG }],
      [{ mediaType: 'image/jpeg', data: PNG }],
      [{ url: `data:image/png;base64,${PNG}` }],
    ])
    expect(results.map(entry => entry.kind === 'result' && entry.images)).toEqual([1, 1, 1])
  })

  it('draws the image only when its step opens, and a press opens the file the step read', async () => {
    const onFile = vi.fn()
    const session = 'a3edf873-cb1c-40ab-a891-f26f5333b320'
    const items = [
      { type: 'user', timestamp: '2026-10-02T23:10:00.000Z', message: { content: 'Look at the forest plot.' } },
      ...lines.slice(0, 2),
      { type: 'assistant', timestamp: '2026-10-02T23:11:00.000Z', message: { model: 'claude-opus', content: [{ type: 'text', text: 'It looks right.' }] } },
    ]
    const bytes = new TextEncoder().encode(items.map(item => JSON.stringify(item)).join('\n') + '\n')
    const fetcher = vi.fn<typeof fetch>(async () => new Response(bytes, { status: 200, headers: { 'x-transcript-offset': '0', 'x-transcript-byte-count': String(bytes.byteLength) } }))
    const band = new TranscriptBand({ shuttleBase: '', fetch: fetcher, inline: true, onFile })
    document.body.append(band.el)
    band.follow({ session, host: 'host-a', agent: 'claude-opus', live: false, at: Date.parse('2026-10-02T23:10:00Z') })
    for (let i = 0; i < 12; i++) await Promise.resolve()
    await new Promise(resolve => requestAnimationFrame(() => resolve(null)))

    expect(band.el.querySelector('img')).toBeNull()
    // Opening the run opens its steps, and only then is the image drawn.
    band.el.querySelector<HTMLButtonElement>('.ws-transcript-steps')!.click()
    const picture = band.el.querySelector<HTMLButtonElement>('.ws-transcript-picture')!
    const img = picture.querySelector('img')!
    expect(img.getAttribute('src')).toBe(`data:image/png;base64,${PNG}`)
    expect(img.loading).toBe('lazy')
    expect(band.el.querySelector('.ws-transcript-output')).toBeNull()
    picture.click()
    expect(onFile).toHaveBeenCalledWith('/scratch/session/forest.png', 'forest.png')
    band.dispose()
  })
})

afterEach(() => document.body.replaceChildren())
