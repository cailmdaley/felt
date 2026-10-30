import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function valid(result) {
  return typeof result?.sha === 'string' && typeof result?.conclusion === 'string'
    && typeof result?.url === 'string' && Number.isFinite(Date.parse(result?.checked_at))
}

function readCache(path) {
  try {
    const result = JSON.parse(readFileSync(path, 'utf8'))
    return valid(result) ? result : null
  } catch { return null }
}

function warn(result) {
  if (result?.conclusion !== 'failure') return
  const oneLine = value => value.replace(/[\r\n]/g, ' ')
  const ageDays = Math.floor((Date.now() - Date.parse(result.checked_at)) / 86_400_000)
  const age = ageDays >= 1 ? ` (cached ${ageDays} day${ageDays === 1 ? '' : 's'} ago)` : ''
  console.log(`CI is red on main at ${oneLine(result.sha).slice(0, 8)}: ${oneLine(result.url)}${age}`)
}

function query(sha) {
  const args = ['api', '--method', 'GET', 'repos/{owner}/{repo}/actions/workflows/ci.yml/runs',
    '-f', 'branch=main', '-f', 'event=push', '-f', 'status=completed', '-f', 'per_page=1']
  if (sha) args.push('-f', `head_sha=${sha}`)
  const response = spawnSync('gh', args, { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 })
  if (response.error || response.status !== 0) return null
  try {
    const run = JSON.parse(response.stdout).workflow_runs?.[0]
    const result = { sha: run?.head_sha, conclusion: run?.conclusion, url: run?.html_url, checked_at: new Date().toISOString() }
    return valid(result) && (!sha || result.sha === sha) ? result : null
  } catch { return null }
}

function refresh(path) {
  const result = query()
  if (!result) return
  const temporary = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(result) + '\n', { mode: 0o600 })
    renameSync(temporary, path)
  } finally {
    try { unlinkSync(temporary) } catch {}
  }
}

try {
  const argument = process.argv[2]
  if (argument === '--refresh') {
    refresh(process.argv[3])
  } else if (argument) {
    // A deploy query never reads or writes the latest-main cache.
    warn(query(argument))
  } else {
    const git = spawnSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8', timeout: 1000 })
    if (git.error || git.status !== 0 || !git.stdout.trim()) process.exit(0)
    const path = join(resolve(git.stdout.trim()), 'felt-ci-status.json')
    warn(readCache(path))
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--refresh', path], {
      detached: true, stdio: 'ignore', cwd: process.cwd(),
    })
    child.on('error', () => {})
    child.unref()
  }
} catch {}
