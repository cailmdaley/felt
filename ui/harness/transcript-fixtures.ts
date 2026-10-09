import claudeUsage from '../src/board/transcript/fixtures/claude-usage.jsonl?raw'
import codexUsage from '../src/board/transcript/fixtures/codex-usage.jsonl?raw'

export const WORKSPACE_LATEST_SESSION = 'c1a5e0d2-5b8f-4c1e-9a7e-2f3d4b5c6a71'
export const WORKSPACE_EARLIER_SESSION = 'd2b6f1e3-6c90-4d2f-8b5a-3e4f6a7b8c92'

export type TranscriptScenario = 'live' | 'large' | 'normal' | 'long-outcome' | 'warm' | 'cold' | 'context'

export const LONG_OUTCOME = 'What changed in the deck:\n\n' + Array.from({ length: 12 }, (_, i) =>
  `${i + 1}. **Validation slide ${i + 1}.** The fictional response and mask-split results are shown alongside the independent reference bins. The source products and reviewer notes are ready for the next check.`,
).join('\n\n')

const encoder = new TextEncoder()
const LARGE_TURNS = 3000

type RecordValue = Record<string, unknown>

function line(record: RecordValue): string {
  return `${JSON.stringify(record)}\n`
}

function timestamp(now: number, offsetMs: number): string {
  return new Date(now + offsetMs).toISOString()
}

function user(now: number, offsetMs: number, content: unknown): string {
  return line({ type: 'user', timestamp: timestamp(now, offsetMs), message: { role: 'user', content } })
}

function assistant(now: number, offsetMs: number, content: unknown): string {
  return line({
    type: 'assistant', timestamp: timestamp(now, offsetMs),
    message: { role: 'assistant', model: 'claude-opus-4-1', content },
  })
}

function ordinaryTranscript(now: number, earlier: boolean, longOutcome = false): string {
  const readId = earlier ? 'fixture-read-earlier' : 'fixture-read-latest'
  const topic = earlier ? 'the first validation pass' : 'the shear-response validation'
  return [
    user(now, -180_000, `Check ${topic} against the independent fixture bins; keep the result with the method note.`),
    assistant(now, -179_000, [
      { type: 'thinking', thinking: 'Compare the stored values to the fictional reference table before summarizing.' },
      { type: 'tool_use', id: readId, name: 'Read', input: { file_path: `/fixture-store/workspace/data/${earlier ? 'first-pass' : 'validation'}.csv` } },
    ]),
    user(now, -178_000, [{ type: 'tool_result', tool_use_id: readId, content: 'ell,response\n100,0.998\n200,1.003\n300,1.001\n' }]),
    assistant(now, -177_000, [{
      type: 'text',
      text: earlier
        ? 'The first pass is consistent with unity across these fixture bins. The remaining question is whether the mask split changes the uncertainty.'
        : 'The fictional response stays within **0.3%** of unity across the validation bins; the mask split is consistent within the stated uncertainty.',
    }]),
    user(now, -90_000, earlier
      ? 'Record the next check so the follow-up has a clear starting point.'
      : 'Summarize the last word for review, including the literal HTML-like text `<img src=x onerror=alert(1)>` as untrusted worker content. The reviewer\'s note:\n\n' +
        '<pasted_content id="6629">\nThe north patch looked noisier than the south one in the first pass.\nCheck that the mask split is not hiding it.\n</pasted_content>'),
    assistant(now, -89_000, [{
      type: 'text',
      text: earlier
        ? 'The follow-up should compare the north and south fixture patches before changing the mask.'
        : longOutcome ? LONG_OUTCOME : 'The check is complete: no correction is needed for these fictional bins. The literal tag stays text, not executable markup.',
    }]),
  ].join('')
}

function largeTranscript(now: number): string {
  const records: string[] = []
  for (let index = 0; index < LARGE_TURNS; index++) {
    const id = `fixture-tool-${index}`
    const start = -LARGE_TURNS * 60 + index * 60
    records.push(user(now, start, `Review fictional response bin ${index + 1}; compare Δχ² and the transfer ratio.`))
    records.push(assistant(now, start + 15, [
      { type: 'thinking', thinking: `Check bin ${index + 1} against the independent simulation row.` },
      { type: 'tool_use', id, name: 'Read', input: { file_path: `/fixture-store/workspace/data/bin-${index + 1}.csv` } },
    ]))
    records.push(user(now, start + 30, [{
      type: 'tool_result', tool_use_id: id,
      content: `bin=${index + 1}\nresponse=${(0.998 + (index % 7) / 1000).toFixed(3)}\nstatus=fixture-only`,
    }]))
    records.push(assistant(now, start + 45, [{
      type: 'text',
      text: `Fixture bin ${index + 1} is within the review tolerance; retain the measured value and continue.`,
    }]))
  }
  return records.join('')
}

/** Fictional native Claude JSONL used by the offline Board harness. */
/**
 * A worker partway through one long exchange: one prompt, then for each update
 * a command and its result followed by a message, so the last exchange grows
 * taller than the page's transcript window.
 */
function liveTranscript(now: number, updates: number): string {
  const records = [user(now, -30_000, 'Run the remaining validation batches and report each one as it lands.')]
  for (let index = 0; index < Math.max(0, Math.min(20, updates)); index++) {
    const update = index + 1
    const at = index * 6000
    const id = `fixture-live-${update}`
    records.push(
      assistant(now, at, [{ type: 'tool_use', id, name: 'Bash', input: { command: `python validate.py --batch ${update}` } }]),
      user(now, at + 200, [{ type: 'tool_result', tool_use_id: id, content: `batch ${update}: 12 bins, max deviation 0.${update}%` }]),
      assistant(now, at + 500, [{
        type: 'text',
        text: `Live worker update ${update}: the next fictional validation batch is in progress.\n\n` +
          `Batch ${update} covers twelve more fixture bins; the largest deviation is 0.${update}%, inside the stated tolerance, so the measured values stand.`,
      }]),
    )
  }
  return records.join('')
}

/** Captured numeric usage, with only its timestamp shifted for screenshot staging. */
function headFacts(now: number, scenario: TranscriptScenario): string {
  if (!['warm', 'cold', 'context'].includes(scenario)) return ''
  const source = scenario === 'context' ? codexUsage : claudeUsage
  const record = JSON.parse(source.trim().split('\n')[0]) as RecordValue
  record.timestamp = timestamp(now, scenario === 'cold' ? -7_200_000 : -60_000)
  return line(record)
}

export function workspaceTranscriptBytes(
  scenario: TranscriptScenario,
  now: number,
  options: { updates?: number; earlier?: boolean } = {},
): Uint8Array {
  const transcriptStart = options.earlier ? now - 5 * 60_000 : now
  const source = scenario === 'large'
    ? largeTranscript(now)
    : ordinaryTranscript(transcriptStart, options.earlier === true, scenario === 'long-outcome') + (scenario === 'live' ? liveTranscript(now, options.updates ?? 0) : '')
  return encoder.encode(source + headFacts(now, scenario))
}
