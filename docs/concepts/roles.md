# Roles

Roles are ordinary Git-synchronized fibers. A role charter holds the durable
context of an office; create one when that context is useful with
`felt add roles/<role> "<Name>"`. Project knowledge belongs in the fibers that
own the subject matter.

## Where a charter lives

A role's charter is the fiber `roles/<role>` at the top of the shared store (the
enclosing store when the current store is a view of it), or
`<mount>/roles/<role>`, where `<mount>` is a top-level entry of the shared
store's `.felt/` that is a symlink to a directory: a repository linked in, such
as one shared with other people ([sharing a store](cross-project.md#sharing-a-store-with-other-people)).
A charter at `shared/roles/analyst` is the `analyst` office as surely as one at
`roles/analyst`. When both exist, the store's own `roles/<role>` wins and
`shuttle check` warns about the one it shadows. A charter two levels down
(`a/b/roles/<role>`) is not one.

`felt show roles/<role>` reaches a charter in either place, because felt
resolves an id by its unique tail; this is how workers read one.

## Holding a role

A fiber's top-level `role:` names who answers for its open work: `<office>` or
`<office>/<person>`, each a slug. The person is the last segment, so
`role: sam` is Sam's own desk and `role: analyst/sam` is Sam in the analyst
office. felt stamps a new open fiber with `git config felt.person` of the
repository that holds it; handing work over is editing the field. Shuttle reads
a constitution's office as the role's first segment: its charter is
`roles/<office>`, and the person's instance `roles/<office>/<person>` is
optional and never checked. A worker reads the office's charter, then the
person's instance if it exists. `shuttle role <fiber> analyst` stores
`analyst/<person>` when the repository names a person.

A role written inside the shuttle block, `shuttle.role`, is read when the fiber
has no top-level `role:`; `shuttle check` warns about it and `shuttle role`
moves it. Shuttle's resolved view (`shuttle ls --json`, `shuttle show --json`, the
board) gives `shuttle.role` as the office and `shuttle.person` as the person.
Setting `shuttle.seat: true` marks a constitution as a seat of its office and
requires a role.
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
