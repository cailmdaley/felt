# Roles and collaborators

Roles and collaborators are ordinary Git-synchronized fibers. A central
`roles/` directory makes them discoverable across projects:

```text
roles/
  review/
    review.md
    fable/
      fable.md
```

A role describes an area of work and shared orientation. Its collaborators
have their own continuing notes within that role. Create them when useful,
not as an automatic matrix of every role and model. Their intrinsic fiber IDs
remain stable when names or paths change.

Collaborator bodies are free-form. Information another worker needs belongs
in the role or the relevant shared task/project; the individual notes may
retain fuller reasoning, history, experiments, or attributed disagreements.
Project knowledge stays in the fibers that own the subject matter. This is a
working practice, not a second commitments database.

`shuttle.agent` chooses the execution recipe. It is separate from a collaborator
and from a role. A role may span several task constitutions, whose own scope
and permissions still govern the work. This also differs from Shuttle's
scheduled **standing role**, a constitution with `shuttle.kind: standing`.

## Synchronization

Workers run `felt sync` before substantive work and read their task, shared
role, and assigned collaborator from the local store. The command resolves
the store's Git repository even through a project's symlinked `.felt` view,
fetches the tracking remote, and merges the branch's upstream. It does not
stage or commit local edits. After committing intentional work, run
`felt sync --push` to incorporate incoming changes and publish to the same
tracking branch.

Conflicts remain ordinary Git conflicts. A worker with the relevant context
reconciles them, commits the resolution, and retries. Failed sync is visible;
no automatic ours/theirs choice, stash, reset, or force-push replaces judgment.
Git-ignored content is not distributed by this workflow.

Neither a role nor a collaborator has a host owner. The same UID identifies
its synchronized copies. Constitutions can be synchronized too;
`shuttle.host` still controls which daemon may dispatch their work. The live
board's host-addressed APIs and backend conversations remain host-addressed.

## Assignment

```bash
felt shuttle assign <task> --role review --collaborator fable
```

Names resolve within the central roles tree. Full role/profile paths and
intrinsic UIDs are also accepted. The stored references contain stable UIDs:

```yaml
collaboration:
  role:
    uid: 01...
  collaborator:
    uid: 01...
```

The block and either reference are optional. Use `--clear-role`,
`--clear-collaborator`, or `--clear` to remove references. `--json-assignment`
accepts an exact replacement object. The assignment writer changes no task
lifecycle, execution settings, or past session attribution.

Launch and resume prompts name the references and the synchronization step.
Workers read the referenced fibers locally by UID. The session ledger records
the assignment and known model configuration at the event; later changes do
not rewrite earlier attribution.

## Handoffs

Keep the task's Status useful during work. A new session reads it and
continues. On a model-version change, inherited notes are evidence the
successor may accept or reconsider, not a command to claim memory. A transfer
to a distinct collaborator should make the new assignment clear. These can be
short ordinary handoffs, without mandatory ceremonies or profile templates.
