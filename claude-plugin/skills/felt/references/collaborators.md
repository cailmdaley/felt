# Roles and collaborators

Roles and collaborators are ordinary fibers in the shared felt store. The
canonical roster lives on a task constitution:

```yaml
collaboration:
  vizier: [fable, astra]
  organizer: [opus]
```

Role names map to `roles/<role>/`; collaborator names map to
`roles/<role>/<collaborator>/`. **A collaborator is named for the model that
plays the role** — `roles/vizier/fable`, `roles/intendant/opus` — so the next
session of that model finds its own notes by knowing what it is. Give the
collaborator fiber a display name like `Opus · intendant`. A role-only entry
such as `organizer: []` is valid when a task belongs to a role but has no named
collaborator. Create identity fibers only when durable context will help;
there is no need to populate every role/collaborator combination.

Roles and collaborators are created by path; `roles/` always stays at the top
level of the store:

```bash
felt -C <shared-store> add roles/intendant "Intendant" -b "<charter: remit, human gates, where the playbooks live>"
felt -C <shared-store> add roles/intendant/opus "Opus · intendant"
```

The roster names the identities on a task; it does not choose the execution
model. At startup the prompt names an actor only when the roster names exactly
one role/collaborator pair. With multiple entries, read the roster from the
task YAML and take the collaborator that carries your model's name.

Keep specific, personal notes in the collaborator's own fiber. Put information
needed across the task in the task constitution, and information shared across
tasks in the global role or project fibers. Task-local notes can live under
`<constitution>/roles/<role>/<collaborator>/` and
`<constitution>/roles/<role>/`; use them when they add useful task context.
These notes concern the same identities, not new task-specific identities.

Identity is the fiber's intrinsic UID. Authored roster entries use readable
names and should be updated when a fiber is renamed. Historical UID mappings
remain readable for compatibility and past records. Session ledgers record
which roster participated in a session; they do not assert that every listed
collaborator authored the session or every change.

## Synchronize, then work locally

```bash
felt sync
felt -C <shared-store> show roles/vizier
felt -C <shared-store> show roles/vizier/fable
```

`felt sync` operates on the Git repository containing the actual felt store,
including when a project's `.felt` is a symlink into that store. It fetches
and merges the current branch's upstream. Edit files normally, or use
`felt edit`. Commit intentional changes, then use `felt sync --push` to merge
incoming work and publish to the tracking branch. Roles and collaborators
have no host owner.

Resolve relevant Git conflicts with the work's context, then stage the
resolution, commit, and retry synchronization. Do not choose an automatic
ours/theirs winner. If staged or overlapping local changes prevent sync,
finish the intended edits rather than discarding or stashing someone else's
work. Make a failed synchronization visible; don't describe an offline copy
as synchronized. Git-ignored content stays local.

## Assigning a task

Add membership without replacing existing roster entries:

```bash
felt shuttle assign <task> --role vizier --collaborator fable --collaborator astra
```

A task with no roster gets one from its worker: pick the role under `roles/`
whose charter fits the work, or create one when none does, and assign it with
yourself as collaborator (your model name, creating the collaborator fiber if
it is new).

Use `--json-assignment` for an exact replacement, such as
`{"vizier":["fable","astra"],"organizer":[]}`. Use `--clear` to remove
the roster. Inputs can name profiles by slug, full path, or UID; the stored
roster uses readable slugs. Renaming a profile means updating authored roster
entries while keeping the fiber's intrinsic UID.

For the session handoff and ledger behavior, read the Shuttle skill's
[continuity reference](../../shuttle/references/continuity.md).
