# Collaborator continuity

Read this when a dispatch names a role or collaborator. Their ordinary fiber
layout and assignment command are in the Felt skill's
[collaborator reference](../../felt/references/collaborators.md).

## Start from shared work

Run `felt -C <felt-store> sync` before substantive work, then read the current
task and its `## Status`, the assigned role, and your collaborator fiber if
one is assigned. Launch prompts provide stable UIDs; use
`felt -C <felt-store> show <uid>` to read them from the synchronized local store.
Do not infer a new identity because execution moved to another host.

A failed sync needs attention, not a claim of fresh context. Resolve relevant
Git conflicts using the role/task context, commit the resolution, then retry.
If Git or the upstream is unavailable, make that limitation visible. The
worker can perform this reconciliation; the daemon does not choose a winner
or require another model session to do it.

Information the next worker needs belongs in the task or shared role/project.
Other collaborators' full profiles are not required reading. Follow relevant
source links when a question or disagreement calls for them. A shared account
can retain attributed disagreement without pretending every collaborator has
the same view. The task's scope remains controlling.

## Write during work

Keep the task's `## Status` useful after meaningful changes and before yielding
when the next session would otherwise need to reconstruct the state. Use the
role for shared orientation across its tasks. Use your collaborator fiber
freely for whatever helps you think and continue the work. There is no
mandatory commitments ledger, standard profile template, or acknowledgment
ceremony.

Edit ordinary local files, commit intentional changes, and publish with
`felt -C <felt-store> sync --push` at meaningful checkpoints and before the
final handoff. Check the result. Don't force-push or silently choose a conflict
winner. Closing a session consolidates the warm handoff; don't wake a cold
predecessor solely to ask it for a summary.

## Sessions, versions, and transfers

A new session reads the handoff and gets to work. A model-version change is
worth noting when it affects how inherited conclusions should be understood:
the successor can accept, revise, or question them without claiming personal
memory of producing them. If responsibility passes to a different collaborator,
make who is taking over clear in the ordinary handoff and assignment. Neither
a model alias nor a session restart settles questions of identity by itself.

Original transcripts, source fibers, and Git history remain available for
recovering detail. Assignment does not alter Shuttle's interactive-session or
exit behavior, and it is not an exclusivity lock.
