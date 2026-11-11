import { expect, mock, test } from 'claude-code/testing'

const SELF = '01M6S35MYBWBA3FYED90DGMSF1'
const DIR = '/Users/x/loom/.felt/loom/tools/hark/holistic-hark'
const BAND = {
  plugin: 'felt',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

function daemon(on: any, voice: object, { companions = [] as string[], fiber = true } = {}) {
  const posts: { url: string; body: string }[] = []
  const reads: string[] = []
  const checked: string[] = []
  on('http.fetch', (_: any, e: any) => {
    if (e.init?.method === 'POST') {
      posts.push({ url: e.url, body: e.init.body })
      return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    }
    reads.push(e.url)
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(voice) } }
  })
  on('fs.read', () => ({ value: `---\nid: ${SELF}\nname: Holistic hark\n---\n` }))
  on('fs.exists', (_: any, e: any) => { checked.push(e.path); return { value: companions.some(file => e.path === `${DIR}/${file}`) } })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  mock.env(on, fiber ? { SHUTTLE_FIBER_PATH: `${DIR}/holistic-hark.md` } : {})
  const clock = mock.clock(on)
  return { posts, reads, checked, clock }
}

const OFF = { available: true, mode: 'off', follow: true, destination: null, paused: false, pending_words: 0, level: null }
const HERE = { ...OFF, mode: 'following', destination: { fiber_id: SELF, name: 'Holistic hark' } }

const ABOVE = { options: { placement: 'above' } } as const
const BELOW = { options: { placement: 'below' } } as const
const label = async (ui: any, key: string) => (await ui.find({ type: 'Button', key }))?.text
const start = async ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

test('sound arriving here: a loud glyph, the words counted, here named, and a cancel', ABOVE, async ($, on) => {
  const { posts } = daemon(on, { ...HERE, pending_words: 12, level: { mic: -30 } })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'mic')).toBe('⚇')
  expect(await ui.find({ type: 'Text', text: ' 12 words' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' → here' })).toBeDefined()
  expect(await label(ui, 'discard')).toBe(' ✕')
  await ui.press({ key: 'discard' })
  await ui.press({ key: 'mic' })
  expect(posts).toEqual([
    { url: 'http://127.0.0.1:4000/api/v1/voice/discard', body: undefined },
    { url: 'http://127.0.0.1:4000/api/v1/voice', body: '{"enabled":false}' },
  ])
  await ui.unmount()
})

test('room noise below speech level keeps the soft glyph', ABOVE, async ($, on) => {
  daemon(on, { ...HERE, level: { mic: -40 } })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'mic')).toBe('⚆')
  await ui.unmount()
})

test('a quiet open mic is the soft glyph and where words would go', ABOVE, async ($, on) => {
  daemon(on, { ...HERE, level: { mic: -60 } })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'mic')).toBe('⚆')
  expect(await ui.find({ type: 'Text', key: 'words' })).toBeUndefined()
  expect(await label(ui, 'discard')).toBeUndefined()
  await ui.unmount()
})

test('following another card names its slug, and its words when there are some', ABOVE, async ($, on) => {
  daemon(on, { ...HERE, destination: { fiber_id: 'ai-futures/felt/voice-modes', name: 'Voice modes' }, pending_words: 8 })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: ' 8 words' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: ' → voice-modes' }))?.props.dimColor).toBe(false)
  await ui.unmount()
})

test('the line in progress counts, and its last words show while speech runs', ABOVE, async ($, on) => {
  daemon(on, { ...HERE, pending_words: 4, preview: { text: 'and then the other thing is sometimes i want to cancel it...' }, sends_in_ms: null })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: ' 16 words' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' · “…sometimes i want to cancel it”' })).toBeDefined()
  expect(await label(ui, 'discard')).toBe(' ✕')
  await ui.unmount()
})

test('quiet after words counts down to the send', ABOVE, async ($, on) => {
  daemon(on, { ...HERE, pending_words: 12, sends_in_ms: 8200 })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: ' · sends in 9s' })).toBeDefined()
  await ui.unmount()
})

test('words for a card with no worker say they need "send"', ABOVE, async ($, on) => {
  daemon(on, { ...HERE, destination: { fiber_id: 'a/voice-modes' }, cold: true, pending_words: 8, sends_in_ms: 3000 })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: ' · asleep, say “send”' }))?.props.color).toBe('warning')
  await ui.unmount()
})

test('the last batch shows what became of it for ten seconds', ABOVE, async ($, on) => {
  // The mocked clock starts at 0: this batch went four seconds ago.
  const last = { at: new Date(-4000).toISOString(), status: 'delivered', text: 'me: okay basically perfect.\nme: last thing\n' }
  const { clock } = daemon(on, { ...HERE, last })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: ' · ✓ 5 words sent' }))?.props.color).toBe('success')
  await clock.advance(7000)
  expect(await ui.find({ type: 'Text', key: 'fate' })).toBeUndefined()
  await ui.unmount()
})

test('a pinned ULID destination shows its name and a pin', ABOVE, async ($, on) => {
  daemon(on, { ...OFF, mode: 'pinned', follow: false, destination: { fiber_id: '01OTHER', name: 'Standup' }, pending_words: 2 })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'mic')).toBe('⚆')
  expect(await ui.find({ type: 'Text', text: ' 📌 → Standup' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 2 words' })).toBeDefined()
  await ui.unmount()
})

test('a pinned target is visible here even while muted', ABOVE, async ($, on) => {
  daemon(on, { ...HERE, mode: 'pinned', follow: false, paused: true })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'mic')).toBe('⊘')
  expect(await ui.find({ type: 'Text', text: ' 📌 → here' })).toBeDefined()
  await ui.unmount()
})

test('muted is the struck glyph alone', ABOVE, async ($, on) => {
  daemon(on, { ...HERE, paused: true, pending_words: 3, destination: { fiber_id: 'a/b' } })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'mic')).toBe('⊘')
  expect(await ui.find({ type: 'Text', key: 'words' })).toBeUndefined()
  await ui.unmount()
})

test('Listening off is the open circle, and a click starts Listen as the board does', ABOVE, async ($, on) => {
  const { posts } = daemon(on, OFF)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'mic')).toBe('○')
  await ui.press({ type: 'Button', key: 'mic' })
  expect(posts.map(post => [post.url, JSON.parse(post.body)])).toEqual([['http://127.0.0.1:4000/api/v1/voice', { enabled: true, muted: false, source: 'desktop' }]])
  await ui.unmount()
})

test('voice unavailable draws no audio side', ABOVE, async ($, on) => {
  daemon(on, { ...OFF, available: false })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'mic' })).toBeUndefined()
  await ui.unmount()
})

test('pins open the family page, tapestry and constitution on the board', ABOVE, async ($, on) => {
  const { posts, reads, checked, clock } = daemon(on, OFF, { companions: ['tapestry.html', 'report.html'] })
  await start($)
  await clock.advance(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'constitution')).toBe('☰')
  expect(await label(ui, 'tapestry')).toBe('⌗')
  expect(await label(ui, 'files')).toBe('⧉')
  expect(await label(ui, 'mic')).toBe('○')
  expect(checked).toEqual([`${DIR}/tapestry.html`])
  expect(reads.every(url => url.endsWith('/voice'))).toBe(true)
  for (const key of ['files', 'tapestry', 'constitution']) await ui.press({ key })
  expect(posts.map(p => [p.url, JSON.parse(p.body)])).toEqual(['files', 'tapestry', 'constitution'].map(page => [
    'http://127.0.0.1:4000/api/v1/board/open', { fiber_id: SELF, page },
  ]))
  await ui.unmount()
})

for (const [file, checkedNames] of [
  ['artifact.html', ['tapestry.html', 'artifact.html']],
  ['report.html', ['tapestry.html', 'artifact.html', 'report.html']],
] as const) {
  test(`${file} alone gives the tapestry pin`, ABOVE, async ($, on) => {
    const { clock, checked } = daemon(on, OFF, { companions: [file] })
    await start($)
    await clock.advance(0)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await label(ui, 'tapestry')).toBe('⌗')
    expect(checked).toEqual(checkedNames.map(name => `${DIR}/${name}`))
    await ui.unmount()
  })
}

test('a fiber without a companion has the family and constitution pins', ABOVE, async ($, on) => {
  const { clock } = daemon(on, OFF)
  await start($)
  await clock.advance(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'constitution')).toBe('☰')
  expect(await label(ui, 'tapestry')).toBeUndefined()
  expect(await label(ui, 'files')).toBe('⧉')
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

for (const [placement, options, request] of [
  ['above', ABOVE, BAND],
  ['below', BELOW, HINT],
] as const) {
  for (const [pins, expected] of [
    [{ companions: ['tapestry.html'] }, ['files', 'tapestry', 'constitution']],
    [{}, ['files', 'constitution']],
  ] as const) {
    test(`${placement}: ${expected.length} pin${expected.length === 1 ? '' : 's'} and audio form a left-hugged cluster`, options, async ($, on) => {
      const { clock } = daemon(on, { ...HERE, pending_words: 12, level: { mic: -20 } }, pins)
      await start($)
      await clock.advance(0)
      const ui = await $.ui.mount({ ...request, surface: 'terminal' } as any)
      const row = await ui.find({ type: 'Box' })
      expect(row?.props.flexDirection).toBe('row')
      expect(row?.children.length).toBe(expected.length + 1)
      for (const [i, key] of expected.entries()) {
        expect(row?.children[i].props).toEqual({ key, marginRight: 1 })
      }
      const audio = row?.children[expected.length]
      expect(audio?.props).toEqual({ flexDirection: 'row' })
      expect(audio?.children.map((child: any) => child.props?.label ?? child.children?.[0])).toEqual(['⚇', ' → here', ' 12 words', 'cancel'])
      await ui.unmount()
    })
  }

  test(`${placement}: audio starts at the left without pins`, options, async ($, on) => {
    daemon(on, HERE, { fiber: false })
    await start($)
    const ui = await $.ui.mount({ ...request, surface: 'terminal' } as any)
    const row = await ui.find({ type: 'Box' })
    expect(row?.children.length).toBe(1)
    expect(row?.children[0].props).toEqual({ flexDirection: 'row' })
    expect(row?.children[0].children[0].props.label).toBe('⚆')
    await ui.unmount()
  })
}

test('below, the line takes the hint text\'s place', BELOW, async ($, on) => {
  daemon(on, { ...HERE, level: { mic: -20 } })
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  await start($)
  const hint = await $.ui.mount({ ...HINT, surface: 'terminal' } as any)
  expect(await hint.find({ type: 'Text', text: /shift\+tab/ })).toBeUndefined()
  expect(await label(hint, 'constitution')).toBe('☰')
  expect(await label(hint, 'mic')).toBe('⚇')
  await hint.unmount()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(band, 'mic')).toBeUndefined()
  await band.unmount()
})

test('above is the default placement', async ($, on) => {
  daemon(on, HERE)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await label(ui, 'mic')).toBe('⚆')
  await ui.unmount()
})
