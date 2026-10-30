#!/bin/sh
# One bounded SessionStart/deploy warning for a failed completed main CI run.
# An optional commit SHA selects the deployment target. All other states,
# offline hosts, and missing tools stay silent and return success.
command -v gh >/dev/null 2>&1 || exit 0
command -v node >/dev/null 2>&1 || exit 0
cd "$(dirname "$0")/.." 2>/dev/null || exit 0
node - "$@" 2>/dev/null <<'JS' || true
const { spawnSync } = require('node:child_process')
try {
  const sha = process.argv[2]
  const args = ['api', '--method', 'GET', 'repos/{owner}/{repo}/actions/workflows/ci.yml/runs',
    '-f', 'branch=main', '-f', 'event=push', '-f', 'status=completed', '-f', 'per_page=1']
  if (sha) args.push('-f', `head_sha=${sha}`)
  const result = spawnSync('gh', args, { encoding: 'utf8', timeout: 900, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 })
  if (result.error || result.status !== 0) process.exit(0)
  const run = JSON.parse(result.stdout).workflow_runs?.[0]
  if (run?.conclusion !== 'failure') process.exit(0)
  const oneLine = value => String(value ?? '').replace(/[\r\n]/g, ' ')
  console.log(`CI is red on main at ${oneLine(run.head_sha).slice(0, 8)}: ${oneLine(run.html_url)}`)
} catch {}
JS
