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
const SPEAK = { available: true, speaking: null, queued: 0, held: [], paused: false, muted: false }

const ABOVE = { options: { placement: 'above' } } as const
const BELOW = { options: { placement: 'below' } } as const
const label = async (ui: any, key: string) => (await ui.find({ type: 'Button', key }))?.text

test('the mic is here: the band is the ticker alone, twenty readings scrolling', ABOVE, async ($, on) => {
  const { clock } = daemon(on, { ...VOICE, target: { fiber_id: SELF }, pending: { fiber_id: SELF, words: 2, text: 'hello there' }, level: { mic: -30, at: '' } }, SPEAK)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 6; i++) await clock.advance(150)
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'mic')).toBe('▃'.repeat(7))
  expect(await ui.find({ type: 'Text', text: /hello/ })).toBeUndefined()
  await ui.unmount()
  for (let i = 0; i < 30; i++) await clock.advance(150)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'mic')).toBe('▃'.repeat(20))
  await ui.unmount()
})

test('ticker glyphs and the speaking voice take theme colours', ABOVE, async ($, on) => {
  const { clock } = daemon(on, { ...VOICE, target: { fiber_id: SELF }, level: { mic: -15, at: '' } },
    { ...SPEAK, speaking: { fiber_id: 'X', voice: 'aria', text: 'a line' } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(150)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'mic')).toBe('▇▇')
  expect((await ui.find({ type: 'Text', text: '▇' }))?.props).toMatchObject({ color: 'warning' })
  expect((await ui.find({ type: 'Text', text: '🔈 aria' }))?.props).toMatchObject({ color: 'claude' })
  await ui.unmount()
})

test('fixed elsewhere, the band names the card alone', ABOVE, async ($, on) => {
  daemon(on, { ...VOICE, target: { fiber_id: 'X', name: 'Civbench' }, preview: { fiber_id: 'X', words: 2, text: 'not mine' } },
    { ...SPEAK, speaking: { fiber_id: 'X', name: 'Civbench', voice: 'aria', text: 'a line' } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'mic')).toBe('🎤 → Civbench')
  expect(await label(ui, 'speaker')).toBe('🔈 aria')
  await ui.unmount()
})

test('muted mic and speaker say so, and a click toggles each', ABOVE, async ($, on) => {
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

test('paused and waiting speaker states', ABOVE, async ($, on) => {
  daemon(on, { ...VOICE, enabled: false, target: null }, { ...SPEAK, held: [{ fiber_id: 'loom/tools/hark/holistic-hark', name: 'Holistic hark', n: 2 }] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'speaker')).toBe('🔈 2 waiting')
  expect(await label(ui, 'mic')).toBeUndefined()
  await ui.unmount()
})

test('nothing shows when the daemon is away', ABOVE, async ($, on) => {
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

test('Listening off and the speaker idle draw nothing', ABOVE, async ($, on) => {
  daemon(on, { ...VOICE, enabled: false, state: 'off', target: null }, SPEAK)
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
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

test('below, the voice line takes the hint text\'s place', BELOW, async ($, on) => {
  const { clock } = daemon(on, { ...VOICE, target: { fiber_id: SELF }, preview: { fiber_id: SELF, words: 1, text: 'hello' }, level: { mic: -49, at: '' } },
    { ...SPEAK, speaking: { fiber_id: 'X', voice: 'aria', text: 'x' } })
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 25; i++) await clock.advance(150)
  const hint = await $.ui.mount({ ...HINT, surface: 'terminal' } as any)
  expect(await hint.find({ type: 'Text', text: /shift\+tab/ })).toBeUndefined()
  expect(await label(hint, 'mic')).toBe('▁'.repeat(20))
  expect(await label(hint, 'speaker')).toBe('🔈 aria')
  await hint.unmount()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(band, 'mic')).toBeUndefined()
  await band.unmount()
})

test('above is the default placement', async ($, on) => {
  const { clock } = daemon(on, { ...VOICE, target: { fiber_id: SELF }, level: { mic: -30, at: '' } }, SPEAK)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(150)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'mic')).toBe('▃▃')
  await ui.unmount()
})

test('held cards show as chips, the two with most first, then +n; a chip opens its card', ABOVE, async ($, on) => {
  const { posts } = daemon(on, { ...VOICE, enabled: false, target: null }, {
    ...SPEAK,
    speaking: { fiber_id: 'X', voice: 'aria', text: 'x' },
    held: [
      { fiber_id: 'loom/tools/hark/holistic-hark', name: 'Holistic hark', n: 1 },
      { fiber_id: 'life/games/civbench', name: 'Civbench', n: 2 },
      { fiber_id: '01FELT', name: 'felt debug', n: 1 },
      { fiber_id: 'a/b/third', name: null, n: 1 },
    ],
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'speaker')).toBe('🔈 aria')
  expect(await label(ui, 'held:life/games/civbench')).toBe('Civbench 2')
  expect(await label(ui, 'held:01FELT')).toBe('felt debug 1')
  expect(await ui.find({ type: 'Text', text: ' +1' })).toBeDefined()
  await ui.press({ key: 'held:life/games/civbench' })
  await ui.press({ key: 'speaker' })
  expect(posts).toEqual([
    { url: 'http://127.0.0.1:4000/api/v1/voice/reveal', body: '{"fiber_id":"life/games/civbench"}' },
    { url: 'http://127.0.0.1:4000/api/v1/speak', body: '{"muted":true}' },
  ])
  await ui.unmount()
})

test('with the speaker idle, the held chip follows a bare speaker; a list with origins reveals with origin', ABOVE, async ($, on) => {
  const { posts } = daemon(on, { ...VOICE, enabled: false, target: null }, {
    ...SPEAK,
    held: [
      { fiber_id: 'loom/tools/hark/holistic-hark', name: 'Holistic hark', n: 3 },
      { fiber_id: 'ai-futures/felt/debug', origin: 'dapmcw68', name: 'felt debug', n: 1 },
    ],
  } as any)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'speaker')).toBe('🔈 3 waiting')
  expect(await label(ui, 'held:ai-futures/felt/debug')).toBe('felt debug 1')
  await ui.press({ key: 'held:ai-futures/felt/debug' })
  expect(posts).toEqual([
    { url: 'http://127.0.0.1:4000/api/v1/voice/reveal', body: '{"fiber_id":"ai-futures/felt/debug","origin":"dapmcw68"}' },
  ])
  await ui.unmount()
})

test('a held chip alone sits after a bare speaker', ABOVE, async ($, on) => {
  daemon(on, { ...VOICE, enabled: false, target: null }, { ...SPEAK, held: [{ fiber_id: 'life/games/civbench', name: 'Civbench', n: 2 }] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'speaker')).toBe('🔈')
  expect(await label(ui, 'held:life/games/civbench')).toBe('Civbench 2')
  await ui.unmount()
})
