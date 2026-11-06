import { expect, mock, test } from 'claude-code/testing'

const SELF = '01M6S35MYBWBA3FYED90DGMSF1'
const BAND = {
  plugin: 'felt',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

function daemon(on: any, voice: object, speak: object) {
  const posts: { url: string; body: string }[] = []
  on('http.fetch', (_: any, e: any) => {
    if (e.init?.method === 'POST') {
      posts.push({ url: e.url, body: e.init.body })
      return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    }
    const body = e.url.endsWith('/voice') ? voice : speak
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('fs.read', () => ({ value: `---\nid: ${SELF}\nname: Holistic hark\n---\n` }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  mock.env(on, { SHUTTLE_FIBER_PATH: '/Users/x/loom/.felt/loom/tools/hark/holistic-hark/holistic-hark.md' })
  const clock = mock.clock(on)
  return { posts, clock }
}

const VOICE = { available: true, enabled: true, muted: false, state: 'listening', pending: null, preview: null, held: [] }
const SPEAK = { available: true, speaking: null, queued: 0, held: {}, paused: false, muted: false }

const label = async (ui: any, key: string) => (await ui.find({ type: 'Button', key }))?.text

test('the mic is here: the band is the words, cut at a word from the left', async ($, on) => {
  const text = 'one two three four five six seven eight nine ten eleven twelve'
  daemon(on, { ...VOICE, target: { fiber_id: SELF, name: 'Holistic hark' }, preview: { fiber_id: SELF, words: 12, text } }, SPEAK)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, bodyColumns: 30 } })
    expect(await label(ui, 'mic')).toBe('…eight nine ten eleven twelve')
    expect(await label(ui, 'speaker')).toBeUndefined()
    await ui.unmount()
  }
})

test('the level ticker leads the words, five readings at most', async ($, on) => {
  const { clock } = daemon(on, { ...VOICE, target: { fiber_id: SELF }, pending: { fiber_id: SELF, words: 2, text: 'hello there' }, level: { mic: -30, at: '' } }, SPEAK)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 6; i++) await clock.advance(150)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'mic')).toBe('▃▃▃▃▃ hello there')
  await ui.unmount()
})

test('fixed elsewhere, the band names the card alone', async ($, on) => {
  daemon(on, { ...VOICE, target: { fiber_id: 'X', name: 'Civbench' }, preview: { fiber_id: 'X', words: 2, text: 'not mine' } },
    { ...SPEAK, speaking: { fiber_id: 'X', name: 'Civbench', voice: 'aria', text: 'a line' } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'mic')).toBe('🎤 → Civbench')
  expect(await label(ui, 'speaker')).toBe('🔈 aria')
  await ui.unmount()
})

test('muted mic and speaker say so, and a click toggles each', async ($, on) => {
  const { posts } = daemon(on, { ...VOICE, muted: true, target: { fiber_id: SELF } }, { ...SPEAK, muted: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'mic')).toBe('🎤 muted')
  expect(await label(ui, 'speaker')).toBe('🔈 muted')
  await ui.press({ key: 'mic' })
  await ui.press({ key: 'speaker' })
  expect(posts).toEqual([
    { url: 'http://127.0.0.1:4000/api/v1/voice', body: '{"muted":false}' },
    { url: 'http://127.0.0.1:4000/api/v1/speak', body: '{"muted":false}' },
  ])
  await ui.unmount()
})

test('paused and waiting speaker states', async ($, on) => {
  daemon(on, { ...VOICE, enabled: false, target: null }, { ...SPEAK, held: { 'loom/tools/hark/holistic-hark': 2 } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'speaker')).toBe('🔈 2 waiting')
  expect(await label(ui, 'mic')).toBeUndefined()
  await ui.unmount()
})

test('nothing shows when the daemon is away', async ($, on) => {
  on('http.fetch', () => { throw new Error('refused') })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  mock.env(on, {})
  mock.clock(on)
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeDefined()
  await ui.unmount()
})

test('Listening off and the speaker idle draw nothing', async ($, on) => {
  daemon(on, { ...VOICE, enabled: false, state: 'off', target: null }, SPEAK)
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeDefined()
  await ui.unmount()
})

test('the ticker and the speaker labels take theme colours', async ($, on) => {
  const { clock } = daemon(on, { ...VOICE, target: { fiber_id: SELF }, pending: { fiber_id: SELF, words: 4, text: 'me: hello S1: hi' }, level: { mic: -15, at: '' } },
    { ...SPEAK, speaking: { fiber_id: 'X', voice: 'aria', text: 'a line' } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(150)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'mic')).toBe('▇▇ me: hello S1: hi')
  expect((await ui.find({ type: 'Text', text: '▇' }))?.props).toMatchObject({ color: 'warning' })
  expect((await ui.find({ type: 'Text', text: 'me:' }))?.props).toMatchObject({ color: 'suggestion' })
  expect((await ui.find({ type: 'Text', text: ' S1:' }))?.props).toMatchObject({ color: 'suggestion' })
  expect((await ui.find({ type: 'Text', text: ' hello' }))?.props).toMatchObject({ dimColor: true })
  expect((await ui.find({ type: 'Text', text: '🔈 aria' }))?.props).toMatchObject({ color: 'claude' })
  await ui.unmount()
})
