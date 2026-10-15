# Roles

Roles are ordinary Git-synchronized fibers under `roles/<role>/`. A role charter
holds the durable context of an office; create one when that context is useful
with `felt add roles/<role> "<Name>"`. Project knowledge belongs in the fibers
that own the subject matter.

A constitution can name one role with `shuttle.role: <role-slug>`. Setting
`shuttle.seat: true` marks it as a seat of that office and requires a role.
A role may have multiple seats. Role and seat do not select a model or execution
backend, and do not change lifecycle. Workers consult a relevant charter when
its context matters; launch prompts do not name a role.

Workers run `felt sync` before substantive work and read the task and relevant
shared role and project notes from the local store. The command resolves the
store's Git repository even through a project's symlinked `.felt` view, fetches
the tracking remote, and merges the branch's upstream. It does not stage or
commit local edits. After committing intentional changes, run `felt sync
--push` to incorporate incoming changes and publish to the same tracking branch.

Conflicts remain ordinary Git conflicts. A worker with relevant context
reconciles them, commits the resolution, and retries. Failed sync is visible;
no automatic ours/theirs choice, stash, reset, or force-push replaces judgment.
Git-ignored content is not distributed by this workflow.

Role charters have no host owner.
Constitutions can be synchronized too; `shuttle.host` controls which daemon may dispatch their work.
The live board's host-addressed APIs and backend conversations remain host-addressed.

Keep the task's `## Status` useful during work. A new session reads it and
continues. Inherited notes are evidence a successor may accept, revise, or
question; handoffs can be short, without mandatory ceremonies or templates.
