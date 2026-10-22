# columns

`cases.json` pins the Desk column of a constitution and its state as a thread,
from its fiber and whether its worker is live. Three classifiers read it and must
agree: the board's (`ui/src/board/deskColumn.ts`, `threads.ts`), the daemon's
(`Shuttle.Threads.column/2`, `thread_state/2`) and `shuttle status --json`'s
(`internal/shuttle/column.go`). `roster`, where present, is the daemon's
roster state when it splits the board's: an armed thread with no live worker is
Armed in the roster and Working on the rails. The `due` cases use dates far
from today in either direction.
