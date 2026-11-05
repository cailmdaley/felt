import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))

export function buildShuttle(dir) {
  const binary = join(dir, 'shuttle')
  execFileSync('go', ['build', '-o', binary, './cmd/shuttle'], { cwd: root })
  return binary
}

/** Exercise the public CLI with a disposable fiber, without touching the operator's store. */
export function bakeChange(binary, repo, base, head, story) {
  const dir = mkdtempSync(join(tmpdir(), 'change-bake-'))
  try {
    mkdirSync(join(dir, '.felt', 'review'), { recursive: true })
    writeFileSync(join(dir, '.felt', 'review', 'review.md'), '---\nname: Review\n---\n')
    const args = ['-C', dir, 'change', 'review', '--repo', repo, '--base', base, '--head', head, '--name', 'snapshot', '--json']
    if (story !== undefined) {
      writeFileSync(join(dir, 'story.json'), JSON.stringify(story))
      args.push('--story', join(dir, 'story.json'))
    }
    const report = JSON.parse(execFileSync(binary, args, { encoding: 'utf8', env: { ...process.env, SHUTTLE_EVENTS_FILE: join(dir, 'events.jsonl'), SHUTTLE_HOST: 'fixture-host' } }))
    return { bundle: JSON.parse(readFileSync(report.path, 'utf8')), report }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = mkdtempSync(join(tmpdir(), 'change-cli-'))
  try {
    const fixture = new URL('../harness/fixtures/dogfood.change.json', import.meta.url)
    const story = JSON.parse(readFileSync(new URL('../harness/fixtures/dogfood.story.json', import.meta.url), 'utf8'))
    const { bundle } = bakeChange(buildShuttle(dir), root, '0f3a0cdc', 'f629d29c417f20c16b8e4415ebd6e424235060d3', story)
    // The harness is portable; the snapshot's Git data is otherwise the CLI's output.
    bundle.repo.dir = '/fixture-repo/felt'
    for (const commit of bundle.commits) commit.author = 'Repository contributor'
    writeFileSync(fixture, JSON.stringify(bundle, null, 2) + '\n')
    console.log(`Baked ${bundle.files.length} files with shuttle change into ${dirname(fileURLToPath(fixture))}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
