import dogfood from './generated/dogfood.change.json'
import plain from './generated/dogfood-plain.change.json'
import type { ChangeBundle } from '../src/board/workspace/changeModel.js'
import imageData from './fixtures/figure.png?inline'
import { PR_FOLLOWER_PRS, PR_FOLLOWER_UID, WORKSPACE_HOST, WORKSPACE_ID, WORKSPACE_REPORT, WORKSPACE_UID, blobFor, type WorkspaceExample } from './workspace-fixtures.js'

/** Real repository snapshot plus no-story and long-file reading probes. */
export function addChangeFixtures(fixture: WorkspaceExample, now: number): void {
  const baked = dogfood as ChangeBundle
  // A story carries its structure as a diagram and its figures beside the bundle, as a PR body does.
  const figure = '\n\n```mermaid\nflowchart LR\n  desk[Desk row] --> reader[Change reader]\n  reader --> story[Story] & map[Map]\n```\n\n![The response figure](figure.png)\n'
  const bundle: ChangeBundle = baked.story ? { ...baked, story: { ...baked.story, overview: baked.story.overview + figure } } : baked
  const owner = fixture.feed.fibers.find(row => (row.fiber as { id: string }).id === WORKSPACE_ID)!
  owner.runtime = { state: 'running', phase: 'waiting', tmux_session: 'fixture-review-worker', started_at: now - 60_000 }
  const dir = WORKSPACE_REPORT.slice(0, WORKSPACE_REPORT.lastIndexOf('/'))
  const header = 'diff --git a/src/large.ts b/src/large.ts\n--- a/src/large.ts\n+++ b/src/large.ts\n'
  const windows = Array.from({ length: 84 }, (_, index) => {
    const start = index * 60 + 1, count = Math.min(60, 5001 - start)
    return { old_from: start, old_lines: count, new_from: start, new_lines: count, rows: count * 2, start: index * 120 }
  })
  const hunks = [{ file: 'src/large.ts', old_from: 1, old_lines: 5000, new_from: 1, new_lines: 5000, windows }]
  const large: ChangeBundle = { ...bundle, title: 'A 5,000-line changed file', head: '5'.repeat(40), story: null,
    areas: [{ name: 'Other', role: 'implementation', files: ['src/large.ts'], lines: 10000 }],
    files: [{ path: 'src/large.ts', role: 'implementation', status: 'modified', additions: 5000, deletions: 5000, header,
      lines: Array.from({ length: 5000 }, (_, index) => [
        { kind: 'deletion' as const, old: index + 1, new: 0, text: `export const value${index + 1} = ${index};` },
        { kind: 'addition' as const, old: 0, new: index + 1, text: `export const value${index + 1} = ${index + 1};` },
      ]).flat(), hunks, remaining: hunks }],
  }
  const paths = [
    ...['bins', 'catalog', 'density', 'sampling', 'weights'].map(name => `src/shear/nz_${name}.py`),
    ...['reader', 'writer', 'schema', 'cache'].map(name => `src/shear/io/${name}.py`),
    ...['estimate', 'response', 'selection'].map(name => `src/shear/calibration/core/${name}.py`),
    'src/shear/obsolete.py', 'src/shear/pipeline.py', 'config/defaults.toml', 'docs/calibration.md',
    ...['bins', 'catalog', 'density', 'sampling', 'weights', 'response', 'pipeline'].map(name => `tests/shear/test_${name}.py`),
    'tests/fixtures/catalog.json', 'generated/schema.json',
  ]
  const treeFiles = paths.map((path, index) => {
    const status = index < 5 ? 'added' : index === 12 ? 'deleted' : index === 13 ? 'renamed' : 'modified'
    const role = path.startsWith('tests/') ? 'test' : path.startsWith('generated/') ? 'generated' : path.startsWith('docs/') ? 'docs' : path.startsWith('config/') ? 'config' : 'implementation'
    const added = status === 'added', deleted = status === 'deleted'
    const hunk = { file: path, old_from: added ? 0 : 1, old_lines: added ? 0 : 1, new_from: deleted ? 0 : 1, new_lines: deleted ? 0 : 1,
      windows: [{ old_from: added ? 0 : 1, old_lines: added ? 0 : 1, new_from: deleted ? 0 : 1, new_lines: deleted ? 0 : 1, rows: added || deleted ? 1 : 2, start: 0 }] }
    return { path, role, status, ...(status === 'renamed' ? { old_path: 'src/shear/run.py' } : {}),
      additions: deleted ? 0 : 1, deletions: added ? 0 : 1,
      header: `diff --git a/${path} b/${path}\n--- ${added ? '/dev/null' : `a/${path}`}\n+++ ${deleted ? '/dev/null' : `b/${path}`}\n`,
      lines: [...(added ? [] : [{ kind: 'deletion' as const, old: 1, new: 0, text: 'value = 0' }]), ...(deleted ? [] : [{ kind: 'addition' as const, old: 0, new: 1, text: 'value = 1' }])],
      hunks: [hunk], remaining: index === 0 ? [] : [hunk] }
  }) satisfies ChangeBundle['files']
  const tree: ChangeBundle = { ...bundle, title: 'Calibrate redshift distributions across the pipeline', head: '6'.repeat(40), files: treeFiles,
    areas: [{ name: 'Redshift distributions', role: 'implementation', files: paths.slice(0, 16), lines: 25 }, { name: 'Tests', role: 'test', files: paths.slice(16, 24), lines: 16 }],
    story: { overview: 'Five small redshift modules keep catalog selection, density estimation and sampling separate. The pipeline composes them; tests check each boundary.', flags: [],
      chapters: [{ id: 'density', title: 'Start with the redshift bins', narrative: 'The bins define the shared coordinate system.', why_here: '',
        stops: [{ file: paths[0], note: 'Build bins before estimating a distribution.', importance: 'important', hunks: treeFiles[0].hunks }] }] },
  }
  for (const [name, change] of [['family', bundle], ['plain', plain as ChangeBundle], ['large', large], ['tree', tree]] as const) {
    const path = `${dir}/${name}.change.json`
    const number = { family: 42, plain: 43, large: 44, tree: 45 }[name]
    const titled = { ...change, title: name === 'plain' ? 'Read a diff without a story' : change.title }
    const metadata = {
      version: 2, title: titled.title, head_ref: `feat/${name}-review`,
      pr: { number, title: titled.title, url: `https://example.invalid/pull/${number}`, head_branch: `feat/${name}-review`, base_branch: 'main', state: 'OPEN', draft: false, mergeable: 'MERGEABLE', checks: { total: 1, passed: 1, failed: 0, pending: 0 } },
      stats: { files: change.files.length, additions: change.files.reduce((n, f) => n + f.additions, 0), deletions: change.files.reduce((n, f) => n + f.deletions, 0) },
    }
    fixture.files.push({ owner: WORKSPACE_HOST, path, mime: 'application/json', body: new Blob([JSON.stringify({ ...metadata, ...titled, head_ref: metadata.head_ref, pr: metadata.pr, stats: metadata.stats })], { type: 'application/json' }) })
    fixture.receipts.push({ ...fixture.receipts[0], uid: WORKSPACE_UID, fiber: WORKSPACE_ID, host: WORKSPACE_HOST, fullPath: path, basename: `${name}.change.json`, timestamp: now - 15_000 })
  }
  fixture.files.push({ owner: WORKSPACE_HOST, path: `${dir}/figure.png`, mime: 'image/png', body: blobFor(imageData, 'image/png') })
  const report = fixture.files.find(file => file.path === WORKSPACE_REPORT)!
  report.body = new Blob([`<!doctype html><html><head><title>Read the family change</title><style>body{font:18px/1.6 system-ui;max-width:680px;margin:80px auto;padding:24px;color:light-dark(#272720,#e2e2da);background:light-dark(#f6f5f0,#242421);color-scheme:light dark}a{color:inherit}li{margin:24px 0}small{opacity:.7}</style></head><body><small>FELT / CHANGE REVIEW</small><h1>A family’s root stays in sight.</h1><p>This small committed diff exercises family navigation. Read the story first, then check the tests and the edits the story doesn’t cover.</p><ul><li><a href="./family.change.json">Read the change →</a></li><li><a href="./plain.change.json">The same diff, without a story</a></li><li><a href="./large.change.json">The 5,000-line stress case</a></li></ul></body></html>`], { type: 'text/html' })
}

/** The PRs the follower constitution names, as GitHub lists them: open and passing, a draft failing a check, merged. */
const FOLLOWED_PRS = [
  { number: 468, title: 'Calibrate n(z) with the SOM', url: 'https://example.invalid/pull/468', head_branch: 'feat/som-nz-calibration', base_branch: 'develop', state: 'OPEN', draft: false, mergeable: 'MERGEABLE', checks: { total: 3, passed: 3, failed: 0, pending: 0 }, additions: 812, deletions: 64 },
  { number: 471, title: 'Read the HATS catalogue lazily', url: 'https://example.invalid/pull/471', head_branch: 'feat/hats-reader', base_branch: 'feat/som-nz-calibration', state: 'OPEN', draft: true, mergeable: 'UNKNOWN', checks: { total: 3, passed: 2, failed: 1, pending: 0 }, additions: 147, deletions: 22 },
  { number: 446, title: 'Mask the tile edges before the shear fit', url: 'https://example.invalid/pull/446', head_branch: 'fix/tile-edges', base_branch: 'develop', state: 'MERGED', draft: false, mergeable: 'UNKNOWN', checks: { total: 3, passed: 3, failed: 0, pending: 0 }, additions: 38, deletions: 11, merge_commit: 'd'.repeat(40) },
].filter(pr => PR_FOLLOWER_PRS.includes(pr.number))

/** The owner's answer to `GET /fibers/<uid>/change`: the PRs the constitution follows. */
export function listFixturePRs(uid: string) {
  return { prs: uid === PR_FOLLOWER_UID ? FOLLOWED_PRS : [] }
}

/**
 * The owner's answer to `POST /fibers/<uid>/change`: the workspace
 * constitution's branch as it stands, story-less and with uncommitted work,
 * a followed PR's change under its own number and title, and every other
 * constitution's an empty change. The bundle lands at the cache path the
 * answer names, for `/file` to serve.
 */
export function bakeFixtureChange(fixture: WorkspaceExample, uid: string, owner: string, number?: number) {
  const baked = plain as ChangeBundle
  const branch = uid === WORKSPACE_UID
  const followed = FOLLOWED_PRS.find(pr => pr.number === (number ?? (uid === PR_FOLLOWER_UID ? FOLLOWED_PRS[0].number : undefined)))
  const path = `/fixture-cache/felt/changes/${uid}/${followed ? `pr-${followed.number}` : branch ? 'calibrate-response' : 'main'}.change.json`
  const change: ChangeBundle = followed
    ? { ...baked, title: followed.title, base_ref: followed.base_branch, head_ref: followed.head_branch, head: String(followed.number).repeat(14).slice(0, 40), pr: followed,
      description: `${followed.title}.\n\nThe fixture's PR body: what it changes and what wants your judgment.` }
    : branch
    ? { ...baked, title: 'Keep the family root visible', base_ref: 'origin/main', head_ref: 'calibrate-response',
      commits: [...baked.commits, { sha: 'c'.repeat(40), subject: 'Uncommitted changes', author: 'Repository contributor', time: baked.commits.at(-1)!.time }],
      description: '**Keep the family root visible**\n\nThe family view drew its leads and lost the root once a request opened. `revealFamily` keeps the root beside every active child, and the README says so.\n\n**Uncommitted changes**' }
    : { ...baked, title: 'main', base: baked.head, base_ref: 'origin/main', head_ref: 'main', commits: [], files: [], areas: [], stats: { files: 0, additions: 0, deletions: 0 }, description: undefined }
  if (!fixture.files.some(file => file.owner === owner && file.path === path)) {
    fixture.files.push({ owner, path, mime: 'application/json', body: new Blob([JSON.stringify(change)], { type: 'application/json' }) })
  }
  return { path, report: { path, valid: true } }
}
