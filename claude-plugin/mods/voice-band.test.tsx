import { expect, mock, test } from 'claude-code/testing'

const SELF = '01M6S35MYBWBA3FYED90DGMSF1'
const DIR = '/Users/x/loom/.felt/loom/tools/hark/holistic-hark'
const BAND = {
  plugin: 'felt',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

function daemon(on: any, voice: object, { files = 0, tapestry = false } = {}) {
  const posts: { url: string; body: string }[] = []
  on('http.fetch', (_: any, e: any) => {
    if (e.init?.method === 'POST') {
      posts.push({ url: e.url, body: e.init.body })
      return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    }
    const body = e.url.endsWith('/voice') ? voice : { files: Array.from({ length: files }, (_, i) => ({ basename: `f${i}` })) }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('fs.read', () => ({ value: `---\nid: ${SELF}\nname: Holistic hark\n---\n` }))
  on('fs.exists', (_: any, e: any) => ({ value: tapestry && e.path === `${DIR}/tapestry.html` }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  mock.env(on, { SHUTTLE_FIBER_PATH: `${DIR}/holistic-hark.md` })
  const clock = mock.clock(on)
  return { posts, clock }
}

const OFF = { available: true, mode: 'off', destination: null, paused: false, pending_words: 0, level: null }
const HERE = { ...OFF, mode: 'following', destination: { fiber_id: SELF, name: 'Holistic hark' } }

const ABOVE = { options: { placement: 'above' } } as const
const BELOW = { options: { placement: 'below' } } as const
const label = async (ui: any, key: string) => (await ui.find({ type: 'Button', key }))?.text
const start = async ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

test('sound arriving here: a loud glyph, the words counted, and a discard', ABOVE, async ($, on) => {
  const { posts } = daemon(on, { ...HERE, pending_words: 12, level: { mic: -30 } })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'mic')).toBe('🔊')
  expect(await ui.find({ type: 'Text', text: ' 12 words…' })).toBeDefined()
  await ui.press({ key: 'discard' })
  await ui.press({ key: 'mic' })
  expect(posts).toEqual([
    { url: 'http://127.0.0.1:4000/api/v1/voice/discard', body: undefined },
    { url: 'http://127.0.0.1:4000/api/v1/voice/toggle', body: undefined },
  ])
  await ui.unmount()
})

test('a quiet open mic is the soft glyph alone', ABOVE, async ($, on) => {
  daemon(on, { ...HERE, level: { mic: -60 } })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'mic')).toBe('🔈')
  expect(await ui.find({ type: 'Text', key: 'words' })).toBeUndefined()
  expect(await label(ui, 'discard')).toBeUndefined()
  await ui.unmount()
})

test('following another card names its slug, and its words when there are some', ABOVE, async ($, on) => {
  daemon(on, { ...HERE, destination: { fiber_id: 'ai-futures/felt/voice-modes', name: 'Voice modes' }, pending_words: 8 })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: ' → voice-modes · 8 words…' })).toBeDefined()
  await ui.unmount()
})

test('a meeting reads as following, and a ULID destination by its name', ABOVE, async ($, on) => {
  daemon(on, { ...OFF, mode: 'meeting', destination: { fiber_id: '01OTHER', name: 'Standup' } })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'mic')).toBe('🔈')
  expect(await ui.find({ type: 'Text', text: ' → Standup' })).toBeDefined()
  await ui.unmount()
})

test('muted is the struck glyph alone', ABOVE, async ($, on) => {
  daemon(on, { ...HERE, paused: true, pending_words: 3, destination: { fiber_id: 'a/b' } })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'mic')).toBe('🔇')
  expect(await ui.find({ type: 'Text', key: 'words' })).toBeUndefined()
  await ui.unmount()
})

test('pins open the constitution, tapestry and sent files on the board', ABOVE, async ($, on) => {
  const { posts, clock } = daemon(on, OFF, { files: 12, tapestry: true })
  await start($)
  await clock.advance(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'constitution')).toBe('☰')
  expect(await label(ui, 'tapestry')).toBe('⌗')
  expect(await label(ui, 'files')).toBe('⧉¹²')
  expect(await label(ui, 'mic')).toBeUndefined()
  for (const key of ['constitution', 'tapestry', 'files']) await ui.press({ key })
  expect(posts.map(p => [p.url, JSON.parse(p.body)])).toEqual(['constitution', 'tapestry', 'files'].map(page => [
    'http://127.0.0.1:4000/api/v1/board/open', { fiber_id: SELF, page },
  ]))
  await ui.unmount()
})

test('a fiber with no tapestry and no sent files has the constitution pin alone', ABOVE, async ($, on) => {
  const { clock } = daemon(on, OFF)
  await start($)
  await clock.advance(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'constitution')).toBe('☰')
  expect(await label(ui, 'tapestry')).toBeUndefined()
  expect(await label(ui, 'files')).toBeUndefined()
  await ui.unmount()
})

test('nothing shows outside a Shuttle worker with the daemon away', ABOVE, async ($, on) => {
  on('http.fetch', () => { throw new Error('refused') })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  mock.env(on, {})
  mock.clock(on)
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeDefined()
  await ui.unmount()
})

const HINT = {
  plugin: 'felt',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '(shift+tab to cycle)' },
  viewport: { columns: 80, rows: 30 },
} as const

test('below, the line takes the hint text\'s place', BELOW, async ($, on) => {
  daemon(on, { ...HERE, level: { mic: -20 } })
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  await start($)
  const hint = await $.ui.mount({ ...HINT, surface: 'terminal' } as any)
  expect(await hint.find({ type: 'Text', text: /shift\+tab/ })).toBeUndefined()
  expect(await label(hint, 'constitution')).toBe('☰')
  expect(await label(hint, 'mic')).toBe('🔊')
  await hint.unmount()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(band, 'mic')).toBeUndefined()
  await band.unmount()
})

test('above is the default placement', async ($, on) => {
  daemon(on, HERE)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'mic')).toBe('🔈')
  await ui.unmount()
})
