# columns

`cases.json` pins where a constitution stands, from its fiber, whether its
worker is live, and optionally the owner's `runtime` record and a launch
`error`:

- `column` — its Desk column. `internal/shuttle/column.go` owns the rule for
  `shuttle status --json`; `Shuttle.Lifecycle.column/3` computes it for every
  row the daemon serves. Both read every case.
- `turn` — whose move it is (`Shuttle.Lifecycle.turn/5`), also served on every
  row.
- `state` — its state as a thread on the board's rails, which the board reads
  from the served column and turn (`ui/src/board/threads.ts` `threadState`).
  `roster`, where present, is the daemon's roster state when it splits the
  board's (`Shuttle.Threads.thread_state/4`): an armed thread with no live
  worker is Armed in the roster and Working on the rails, and a blocked one is
  Blocked in the roster and Waiting on the rails.

The `due` cases use dates far from today in either direction.
