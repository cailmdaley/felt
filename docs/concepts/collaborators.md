# Roles and collaborators

Roles and collaborators are ordinary Git-synchronized fibers. A task's
optional `collaboration` field is a readable roster keyed by role:

```yaml
collaboration:
  vizier: [fable, astra]
  organizer: [opus]
```

Role fibers live at `roles/<role>/`; collaborator fibers live at
`roles/<role>/<collaborator>/`. A role can have an empty collaborator list.
Create fibers when their durable context is useful, not as an automatic
matrix. Project knowledge belongs in the fibers that own the subject matter.

The roster names identities; it does not select a model or execution backend.
The current request establishes the acting identity. Startup prompts name an
actor only when the roster contains exactly one role/collaborator pair. With
multiple entries, read the task's YAML directly without duplicating it in the
prompt or inferring identity from a model name.

Keep specific notes in a collaborator's own fiber. Shared information belongs
in the task or global role/project fibers. Optional task-local notes may live
under `<constitution>/roles/<role>/<collaborator>/` and
`<constitution>/roles/<role>/`; they add context for that task while referring
to the same identities, not creating new ones.

Each fiber's intrinsic UID identifies it across moves and renames. Authored
roster names need updating when a fiber is renamed; historical UID mappings
remain readable for compatibility and history. Session ledgers record roster
participation; they do not claim that every listed collaborator authored a
session or its changes.

## Synchronization

Workers run `felt sync` before substantive work and read the task and relevant
shared role, project, or collaborator notes from the local store. The command
resolves the store's Git repository even through a project's symlinked `.felt`
view, fetches the tracking remote, and merges the branch's upstream. It does
not stage or commit local edits. After committing intentional changes, run
`felt sync --push` to incorporate incoming changes and publish to the same
tracking branch.

Conflicts remain ordinary Git conflicts. A worker with relevant context
reconciles them, commits the resolution, and retries. Failed sync is visible;
no automatic ours/theirs choice, stash, reset, or force-push replaces
judgment. Git-ignored content is not distributed by this workflow.

Neither a role nor a collaborator has a host owner. Constitutions can be
synchronized too; `shuttle.host` still controls which daemon may dispatch their
work. The live board's host-addressed APIs and backend conversations remain
host-addressed.

## Assignment

`felt shuttle assign <fiber> --role <name>` and repeatable
`--collaborator <name>` flags add roster membership. The additive flags
preserve existing entries; use `--json-assignment` to replace the entire map
or `--clear` to remove it. The board's assignment endpoint takes the same
exact replacement map. These writes do not change task status, execution
settings, or prior session attribution. See the [CLI reference](../reference/cli.md)
and [API reference](../reference/api.md) for details.

## Handoffs

Keep the task's `## Status` useful during work. A new session reads it and
continues. Inherited notes are evidence a successor may accept, revise, or
question. Make a transfer between distinct collaborators clear in the ordinary
handoff and roster. These can be short, without mandatory ceremonies or
profile templates.
