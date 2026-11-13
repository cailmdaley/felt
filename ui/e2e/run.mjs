import { spawnSync } from 'node:child_process'

// Header, living-report and map-view journeys register with the workspace suite.
// The *-live probes require a running daemon and stay opt-in.
for (const suite of ['workspace', 'changeSmoke', 'consolePicker', 'actionMenu', 'moveMenu', 'modalOverlays', 'requestBudget', 'performance', 'voice']) {
  console.log(`\n=== ${suite} ===`)
  const result = spawnSync(process.execPath, [`e2e/${suite}.mjs`], { stdio: 'inherit', env: process.env })
  if (result.error) console.error(result.error)
  if (result.status !== 0) process.exitCode = 1
}
