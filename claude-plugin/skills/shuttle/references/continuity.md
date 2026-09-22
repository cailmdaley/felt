# Collaborator continuity

Read this when a dispatch carries a collaborator or role assignment. The felt
skill's [collaborator reference](../../felt/references/collaborators.md) defines
the identity and document shapes; this page covers session behavior.

## Land with the inherited context

The launch prompt names each assigned UID and origin. Fetch each authoritative
fiber through the local daemon:

```text
GET /api/v1/fibers/<uid>?body=true&origin=<owning-host>
```

Select the matching entry from the response's `fibers` array. Verify both
returned facts before using it: the top-level `host` must equal the reference's
explicit `origin`, and the entry's `fiber.uid` must equal the requested UID.
The router deliberately degrades an unknown origin to a local lookup, so a 200
response alone is insufficient; a mismatch means the assigned context is
missing or misrouted. Do not accept a local git mirror in its place.

Read the collaborator profile as the inherited orientation and the role as the
standing remit. Briefly accept the commitments you are taking over and state
any disagreement that changes the work. Do not require an acknowledgment of
every note. Then read the constitution and its current `## Status` as the task
contract and immediate handoff. The constitution's scope and gates remain
controlling; the broader role does not authorize work on all constitutions it
touches. A collaboration role is also different from `shuttle.kind: standing`,
which means a scheduled constitution.

A fresh session is a compression boundary, not a new identity. The profile and
handoff should be enough to move; transcripts, commits, and linked sources hold
the detail and remain available for surgical recovery. A model switch does not
decide identity: explicitly choose whether the successor continues the same
collaborator or transfers the work to a distinct collaborator, and record the
handoff and inherited attribution either way. Helpers and peer sessions retain
their own contribution attribution; their work does not silently rewrite the
assigned identity.

## Keep the handoff warm

Rewrite the task's `## Status` after a meaningful transition while the state is
fresh: a decision changes the direction, a result invalidates the working
model, a substantial slice lands, or a blocker appears. Also refresh it before
returning a turn to the human when the next turn would otherwise have to
reconstruct changed state. The exit handoff consolidates this current account;
it should not be the first time the session records it.

Update the collaborator fiber when the durable orientation changes: inherited
commitments, corrections and their reasons, unresolved doubts, or source
pointers another instance will need. Write through owner-routed
`POST /api/v1/felt-edit` with the collaborator fiber's explicit `origin` and
the complete revised body. Never edit another host's mirror directly. Keep
task progress in the constitution's `## Status`; keep only cross-task
orientation in the collaborator profile.

Do not wake an idle, cold session solely to ask it for a summary. Preserve the
last warm handoff and let the next session amend it as part of substantive
work.

For the initial practice, avoid two simultaneously active sessions carrying
the same collaborator identity. Shuttle does not enforce exclusivity, so
coordinate this at dispatch time rather than treating assignment as a lock.
The human may still keep the current session interactive or request a handoff;
assignment does not change shuttle's ordinary exit semantics.
