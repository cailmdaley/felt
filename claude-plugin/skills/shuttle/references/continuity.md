# Collaboration continuity

Read this when a task carries a collaboration roster. Its layout and authoring
practice are in the Felt skill's
[collaborator reference](../../felt/references/collaborators.md).

## Start from shared work

Run `felt -C <felt-store> sync` before substantive work, then read the current
task and its `## Status`, the roster in its YAML, and the relevant global or
task-local role/project/collaborator notes. The current request establishes
who is acting. Launch prompts name an actor only when the roster has exactly
one role/collaborator pair; otherwise read the YAML roster directly.
Do not infer identity from the model or execution host.

Read global `roles/<role>/<collaborator>` paths with `felt -C <shared-store>`;
the launch prompt supplies that store. A project view can also contain
task-local notes with the same path suffix, so use its explicit task path for
those notes.

A failed sync needs attention, not a claim of fresh context. Resolve relevant
Git conflicts using the task and shared context, commit the resolution, then
retry. If Git or the upstream is unavailable, make that limitation visible.
The worker can perform this reconciliation; the daemon does not choose a
winner or require another model session to do it.

Information the next worker needs belongs in the task or shared role/project.
Specific notes belong in the named collaborator's fiber. Task-local notes can
sit under `<constitution>/roles/<role>/<collaborator>/` or
`<constitution>/roles/<role>/`; these are notes about the same identity and
role, not new identities. Other collaborators' full notes are not required
reading. Follow relevant source links when a question or disagreement calls
for them. Keep disagreement attributed where that context helps; roster
participation does not mean every listed collaborator holds every view.

## Write during work

Keep the task's `## Status` useful after meaningful changes and before yielding
when the next session would otherwise need to reconstruct the state. Use
global roles for shared orientation across tasks and task-local role notes
only when they add useful context. Keep specific notes in the collaborator's
own fiber. There is no mandatory profile template or acknowledgment ceremony.

Edit ordinary local files, commit intentional changes, and publish with
`felt -C <felt-store> sync --push` at meaningful checkpoints and before the
final handoff. Check the result. Don't force-push or silently choose a conflict
winner. Closing a session consolidates the warm handoff; don't wake a cold
predecessor solely to ask it for a summary.

## Sessions and history

Session ledgers store the roster configured at launch. They do not
assert that every roster member authored the session or all changes made in
it. A new session reads the handoff and may accept, revise, or question its
conclusions without claiming personal memory of producing them. If
responsibility passes to a different collaborator, make the transfer clear in
the ordinary handoff and update the readable roster as appropriate.

Fiber UIDs remain intrinsic to the fibers. Keep authored roster names current
when role or collaborator fibers are renamed; historical UID mappings remain
readable for compatibility and past records. Original transcripts, source
fibers, and Git history remain available for recovering detail. Assignment
does not alter Shuttle's interactive-session or exit behavior, and it is not
an exclusivity lock.
