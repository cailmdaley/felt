# felt + Shuttle

The canonical contributor and operator guide is **[AGENTS.md](AGENTS.md)** —
architecture, build/lifecycle, deploy, invariants, and dispatch mechanics all
live there. (Many tools read `AGENTS.md`; this file is just a pointer.)

One invariant rides here because every session must hold it, including yours:

**A fiber's owning host is its only read and write path. Git sync is never the
answer.** Every fiber is owned by exactly one host; cross-host reads and writes
are owner-routed over the daemon socket (`Shuttle.OriginRouter` — the local
daemon forwards to the owner's identical endpoint over the SSH tunnel). This
binds *you*, not just the code: to hand-edit a fiber another host owns, POST
the local daemon's `/api/v1/felt-edit` (it routes by owner) — never `felt edit`
against the local checkout, never a loom `git pull`/`push` to "sync state".
A git mirror that happens to hold a remote fiber's files is incidental; any
fix, feature, or diagnosis that leans on it is wrong by construction. When a
cross-host behavior seems to need git, the model is being misread — re-read
AGENTS.md "Critical invariants" before acting.
