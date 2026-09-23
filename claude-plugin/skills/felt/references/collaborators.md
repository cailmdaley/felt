# Roles and collaborators

Roles live at the top of the felt store, with collaborators beneath their role:

```text
roles/
  review/
    review.md
    fable/
      fable.md
    astra/
      astra.md
```

These are ordinary, usually statusless fibers. Tag the role `role` and a
collaborator `collaborator` for discovery. Create collaborators when useful;
there is no need to populate every model/role combination. Project knowledge
stays in its existing fibers, linked from the role.

The role describes the work and holds useful shared context. Collaborators
can use their own fibers freely: orientation, experiments, disagreements,
history, or reasons to reconsider a past conclusion. Information another
worker needs belongs in the role or the relevant shared task/project, even
when its fuller explanation lives in a collaborator's notes. Preserve who
held a view when disagreement matters; no particular template is required.

A collaborator is scoped to its role. `shuttle.agent` separately chooses the
execution model and harness. A role can cover several constitutions; it is
not the same as a scheduled constitution (`shuttle.kind: standing`). The
current task still determines what work is authorized.

## Synchronize, then work locally

```bash
felt sync
felt show roles/review
felt show roles/review/fable
```

`felt sync` operates on the Git repository containing the actual felt store,
including when a project's `.felt` is a symlink into that store. It fetches
and merges the current branch's upstream. Edit files normally, or use
`felt edit`. Commit intentional changes, then use `felt sync --push` to merge
incoming work and publish to the tracking branch. There is no special
role-saving operation and no host owner on a role or collaborator.

Resolve relevant Git conflicts with the work's context, then stage the
resolution, commit, and retry synchronization. Do not choose an automatic
ours/theirs winner. If staged or overlapping local changes prevent sync,
finish the intended edits rather than discarding or stashing someone else's
work. Make a failed synchronization visible; don't describe an offline copy
as synchronized. Git-ignored content stays local.

## Assigning a task

Use meaningful names from the synchronized store:

```bash
felt shuttle assign <task> --role review --collaborator fable
```

Full `roles/...` paths and intrinsic UIDs also work. The writer resolves names
to stable references, so renaming a fiber does not replace its identity:

```yaml
collaboration:
  role:
    uid: 01...
  collaborator:
    uid: 01...
```

The block is optional. `--clear-role`, `--clear-collaborator`, and `--clear`
remove references; `--json-assignment` replaces the block with validated UID
references. Assignment changes no worker lifecycle or execution settings.
Session history records assignments without claiming authorship of every
fiber touched. Profile content is read locally after sync, not routed by a
machine address. `shuttle.host` continues to select which daemon may execute
a constitution, even when its file is synchronized to other machines.

For session behavior and model-version handoffs, read the Shuttle skill's
[continuity reference](../../shuttle/references/continuity.md).
