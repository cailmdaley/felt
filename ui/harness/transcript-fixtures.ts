export const WORKSPACE_LATEST_SESSION = 'c1a5e0d2-5b8f-4c1e-9a7e-2f3d4b5c6a71'
export const WORKSPACE_EARLIER_SESSION = 'd2b6f1e3-6c90-4d2f-8b5a-3e4f6a7b8c92'

/** Grouped index replies: two served sessions and one without a board card. */
export function transcriptSearchHits(now: number) {
  const stamp = (minutes: number): string => new Date(now - minutes * 60_000).toISOString()
  return [
    { session: WORKSPACE_LATEST_SESSION, harness: 'claude', project: '/fixture-store/workspace', path: '/fixture-store/.claude/projects/workspace/latest.jsonl', line: 12, timestamp: stamp(90), role: 'assistant', score: 14.2, matches: 12,
      snippet: '…equal-area keeps every patch statistically comparable, which the four-patch footprint «split» does not. The «mask» comparison is ready…', fibers: [{ id: 'research/workspace/calibration-report', name: 'Calibration report' }] },
    { session: WORKSPACE_EARLIER_SESSION, harness: 'claude', project: '/fixture-store/workspace', path: '/fixture-store/.claude/projects/workspace/earlier.jsonl', line: 4, timestamp: stamp(60 * 26), role: 'user', score: 11.8, matches: 2,
      snippet: '…compare the north and south fixture patches before changing the «mask»…', fibers: [{ id: 'research/workspace/calibration-report', name: 'Calibration report' }] },
    { session: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', harness: 'codex', project: '/fixture-store/pipeline', path: '/fixture-store/.codex/sessions/rollout-pipeline.jsonl', line: 233, timestamp: stamp(60 * 24 * 6), role: 'tool_result', score: 8.4, matches: 5,
      snippet: '…config.yaml: «mask»: footprint, «split»: four-patch (unused)…', fibers: [] },
  ]
}

export const LONG_OUTCOME = 'What changed in the deck:\n\n' + Array.from({ length: 12 }, (_, i) =>
  `${i + 1}. **Validation slide ${i + 1}.** The fictional response and mask-split results are shown alongside the independent reference bins. The source products and reviewer notes are ready for the next check.`,
).join('\n\n')
