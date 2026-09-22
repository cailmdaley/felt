# Collaborators and roles

Collaboration references let a constitution name who carries work across
sessions and what standing remit they are working within. They are optional:
an unassigned constitution remains valid.

```yaml
collaboration:
  collaborator:
    uid: 01...
    origin: <owning-host>
  role:
    uid: 01...
    origin: <owning-host>
```

Either reference may appear alone. Each points to an ordinary fiber by its
intrinsic UID and owning host. The reference is deliberately small: names and
paths can change; the UID is identity, and `origin` tells shuttle which daemon
holds the authoritative document.

## Collaborator

A collaborator is an ordinary, statusless fiber tagged `collaborator`. Its UID
is one durable identity across sessions and tasks. Its body is a current-state
orientation: commitments it has inherited, judgments it is carrying, durable
preferences or working agreements, unresolved doubts, and links to the sources
that let a later session recover the detail. Rewrite it by correction as that
understanding changes. Record a correction with enough reason that a later
instance does not confidently revive the discarded view.

Identity is not a model name. Several collaborators may use the same model and
remain distinct because their UIDs differ. A model change does not itself
decide whether identity continues: choose whether the successor carries the
same collaborator UID or receives a distinct one, and make the handoff and
inherited attribution explicit either way. The successor briefly accepts the
inherited commitments and names any disagreement. Temporary helpers retain
their own attribution in session and event history; they do not become the
assigned collaborator merely by contributing.

Do not turn the collaborator fiber into a diary or transcript. Fresh sessions
compress the working model into an orientation; the original transcripts,
commits, and linked source fibers remain available when detail matters. Update
the profile during the work when a commitment, correction, source, or live doubt
materially changes. Do not wake a cold session solely to manufacture a closing
summary; let the next active instance inherit the existing profile and amend it
when it resumes real work.

For the first experiment, keep one active session per collaborator as an
operating practice. This is coordination discipline, not a distributed lock or
an API guarantee.

## Role

A role is another ordinary fiber. It describes a durable remit: responsibilities,
boundaries, recurring commitments, and the signals that should change its
course. A collaborator can fill a role; the two are not the same thing. Existing
constitutions remain the work units and refer to the role rather than being
absorbed into its body. The assigned constitution still controls the current
work's scope and gates; a role reference is not permission to execute every
constitution within that remit.

This collaboration role is also distinct from shuttle's existing **standing
role**, which is a scheduled constitution (`shuttle.kind: standing`). A broad
role profile may span oneshot, pinned, and standing constitutions.

Keep execution separate. `shuttle.agent` selects the CLI, model, and launch
settings for a dispatch. It neither establishes identity nor defines the role.

## Assigning references

Use the validated assignment writer rather than hand-editing structured
frontmatter:

```bash
felt shuttle assign <fiber> \
  --collaborator <collaborator-uid> \
  --collaborator-origin <owning-host> \
  --role <role-uid> \
  --role-origin <owning-host>
```

Individual reference flags update that reference while preserving the other.
Each UID flag must be paired with its origin. Remove one reference with
`--clear-collaborator` or `--clear-role`; remove the whole block with `--clear`.
For an exact replacement, pass the raw `collaboration` object:

```bash
felt shuttle assign <fiber> --json-assignment \
  '{"collaborator":{"uid":"01...","origin":"<owning-host>"}}'
```

Assignment validates and locks the update, but changes no felt status and
starts or stops no worker. It is neither authorship nor ownership of every
fiber the collaborator touches. Contribution provenance remains in shuttle's
session and event history rather than mutable author or model fields. A
source-linked message can inform the profile while its temporary session author
remains visible in that history.

The CLI writes the task fiber through the store visible on the current host; it
does not owner-route that target. From another host, send the exact replacement
through the local daemon, naming the task fiber's owner in `origin`:

```bash
curl --fail -sS -X POST http://127.0.0.1:4000/api/v1/felt-edit \
  -H 'Content-Type: application/json' \
  -d '{"fiber_id":"<task-fiber>","origin":"<task-owning-host>","collaboration":{"collaborator":{"uid":"<UPPERCASE-ULID>","origin":"<profile-owning-host>"}}}'
```

The referenced collaborator and role may each live on another host; their own
`origin` fields route later reads and writes.

When the assigned fibers live on another host, all reads and writes go through
their owning daemon. Never use a git-synced mirror as a substitute. The shuttle
continuity reference carries the runtime read, verification, and update rules.
