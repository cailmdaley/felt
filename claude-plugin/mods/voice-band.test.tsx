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
  mock.clock(on)
  return posts
}

const VOICE = { available: true, enabled: true, muted: false, state: 'listening', pending: null, preview: null, held: [] }
const SPEAK = { available: true, speaking: null, queued: 0, held: {}, paused: false, muted: false }

test('the mic is here: the band is the words', async ($, on) => {
  daemon(on, { ...VOICE, target: { fiber_id: SELF, name: 'Holistic hark' }, preview: { fiber_id: SELF, words: 3, text: 'hello there you' } }, SPEAK)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Button', key: 'mic' })).toMatchObject({ text: '🎤' })
    expect(await ui.find({ type: 'Text', text: /hello there you/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'speaker' })).toMatchObject({ text: '🔈' })
    await ui.unmount()
  }
})

test('fixed elsewhere, the band names the card and hides its words', async ($, on) => {
  daemon(on, { ...VOICE, target: { fiber_id: 'X', name: 'Civbench' }, preview: { fiber_id: 'X', words: 2, text: 'not mine' } },
    { ...SPEAK, speaking: { fiber_id: 'X', name: 'Civbench', voice: 'aria', text: 'a line' } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'mic' })).toMatchObject({ text: '🎤 → Civbench' })
  expect(await ui.find({ type: 'Button', key: 'speaker' })).toMatchObject({ text: '🔈 Civbench: a line' })
  expect(await ui.find({ type: 'Text', text: /not mine/ })).toBeUndefined()
  await ui.unmount()
})

test('muted mic and speaker say so; m and s post the mutes', async ($, on) => {
  const posts = daemon(on, { ...VOICE, muted: true, target: { fiber_id: SELF } }, { ...SPEAK, muted: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'mic' })).toMatchObject({ text: '🎤 muted' })
  expect(await ui.find({ type: 'Button', key: 'speaker' })).toMatchObject({ text: '🔈 muted' })
  await ui.press({ key: 'mic' })
  await ui.press({ key: 'speaker' })
  expect(posts).toEqual([
    { url: 'http://127.0.0.1:4000/api/v1/voice', body: '{"muted":false}' },
    { url: 'http://127.0.0.1:4000/api/v1/speak', body: '{"muted":false}' },
  ])
  await ui.unmount()
})

test('lines held for this card are counted', async ($, on) => {
  daemon(on, { ...VOICE, target: { fiber_id: SELF } }, { ...SPEAK, held: { 'loom/tools/hark/holistic-hark': 2 } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'speaker' })).toMatchObject({ text: '🔈 2 held' })
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

test('with Listening off and the speaker idle, the band passes', async ($, on) => {
  daemon(on, { ...VOICE, enabled: false, state: 'off', target: null }, SPEAK)
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeDefined()
  await ui.unmount()
})

test('with Listening off, a speaking line shows without the mic', async ($, on) => {
  daemon(on, { ...VOICE, enabled: false, state: 'off', target: null },
    { ...SPEAK, speaking: { fiber_id: 'X', name: null, voice: 'aria', text: 'hi' } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'mic' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'speaker' })).toMatchObject({ text: '🔈 aria: hi' })
  await ui.unmount()
})
