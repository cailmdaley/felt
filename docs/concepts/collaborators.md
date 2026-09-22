# Collaborators and roles

Shuttle can optionally assign durable identity and remit to a constitution.
The assignment is a pair of references to ordinary fibers:

```yaml
collaboration:
  collaborator:
    uid: 01...
    origin: <owning-host>
  role:
    uid: 01...
    origin: <owning-host>
```

Either reference may be omitted. A constitution with no `collaboration` block
continues to work normally.

## Three independent concerns

| Surface | Meaning |
|---|---|
| Collaborator fiber | Who carries commitments and orientation across sessions and tasks |
| Role fiber | The durable remit, boundaries, and recurring responsibilities |
| `shuttle.agent` | The execution recipe: harness, model, effort, and other launch settings |

A collaborator is not a model. Two identities can use the same model. A model
switch may continue the same identity or transfer work to a distinct one; make
that choice and the inherited attribution explicit. A role is not a
collaborator: one describes the responsibility, the other carries it.
Constitutions remain the units of work and may link to an existing role.

## The collaborator fiber

Create an ordinary statusless fiber tagged `collaborator`. Its intrinsic UID is
the stable identity. Keep its body as a current orientation rather than a
chronicle: commitments, working agreements, corrections with reasons,
unresolved doubts, and pointers to original sources. Session transcripts and
the event history retain contribution provenance; assignment does not add a
mutable author or model field to every fiber.

Fresh sessions work from this compressed orientation, while transcripts,
commits, and linked fibers preserve the fuller source record. Update the body
when durable understanding changes during real work. There is no need to wake
an idle session only to produce a summary.

The first operating practice keeps one active session per collaborator. This
is a coordination convention, not an exclusivity guarantee enforced by the
daemon.

## The role fiber

A role is also an ordinary fiber. Its body says what the remit is, what lies
outside it, what commitments recur, and what evidence should change its
direction. Existing constitutions refer to that role; they do not need to be
migrated or rewritten around it. The assigned constitution still determines
the current worker's scope and gates; a broad role is not permission to execute
every task within its remit.

This is separate from shuttle's existing **standing role**, meaning a scheduled
constitution with `shuttle.kind: standing`. A collaboration role may span
oneshot, pinned, and standing constitutions.

## Assigning a constitution

Use the validated writer:

```bash
felt shuttle assign <fiber> \
  --collaborator <collaborator-uid> \
  --collaborator-origin <owning-host> \
  --role <role-uid> \
  --role-origin <owning-host>
```

Each UID flag is paired with its origin; updating one reference preserves the
other. `--clear-collaborator` and `--clear-role` remove one reference, while
`--clear` removes the whole block. For an exact replacement,
`--json-assignment` accepts the raw object stored under `collaboration`:

```bash
felt shuttle assign <fiber> --json-assignment \
  '{"collaborator":{"uid":"01...","origin":"<owning-host>"}}'
```

Assignment validates the shape and locks the update without trying to resolve
profiles through a local mirror. It does not change the fiber's status,
dispatch a worker, or claim authorship.

The CLI targets a fiber in a store visible on its current host. To assign a
fiber owned by another host, use the owner-routed daemon endpoint and put the
raw assignment under `collaboration`:

```bash
curl --fail -sS -X POST http://127.0.0.1:4000/api/v1/felt-edit \
  -H 'Content-Type: application/json' \
  -d '{"fiber_id":"<task-fiber>","origin":"<task-owning-host>","collaboration":{"collaborator":{"uid":"<UPPERCASE-ULID>","origin":"<profile-owning-host>"}}}'
```

The referenced profile and role may themselves have different owners.

Both UID and origin matter across hosts. Workers fetch assigned fibers through
the owner-routed daemon API and verify that the response reports the requested
UID and owning host. A git-synced copy on another host is incidental and must
not be used as the profile or role source.
