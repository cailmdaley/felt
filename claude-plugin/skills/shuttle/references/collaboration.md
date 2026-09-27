# Roles and collaborators

A task constitution can carry a collaboration roster naming the offices and identities that work it:

```yaml
collaboration:
  vizier: [fable, astra]
  organizer: [opus]
```

Roles and collaborators are ordinary fibers at the top level of the shared store. A role maps to `roles/<role>/`, whose body is the **charter**: remit, human gates, where the playbooks live. A collaborator maps to `roles/<role>/<collaborator>/` and **is named for the model that plays the role** — `roles/vizier/fable`, `roles/intendant/opus` — so the next session of that model finds its own page by knowing what it is. Keep that page thin (voice and stance); what the office knows belongs on the role. A role may carry a name that emerges from its first real run (the intendant is Colbert): it belongs to the office, every holder inherits it, and any holder may decline it with a note. A role-only entry such as `organizer: []` is valid. Create identity fibers only when durable context will help.

The roster names identities; it does not choose the execution model (`shuttle.agent` does).

## Arriving

The launch prompt names an actor only when the roster has exactly one role/collaborator pair; otherwise read the roster from the task's YAML and take the collaborator named for your model. Read the global `roles/<role>` charter and `roles/<role>/<collaborator>` page with `felt -C <shared-store> show` (the prompt supplies the store). Other collaborators' full notes are not required reading; follow source links when a question or disagreement calls for them.

**A task with no roster gets one from its worker**, before substantive work. Find the charter under `roles/` that fits (`felt -C <shared-store> ls roles`), or create one when none does, and assign it with yourself as collaborator:

```bash
felt -C <shared-store> add roles/intendant "Intendant" -b "<charter: remit, human gates, where the playbooks live>"
felt -C <shared-store> add roles/intendant/opus "Opus · intendant"     # only if new and worth a page
felt shuttle assign <task> --role intendant --collaborator opus
```

`assign` adds membership without replacing existing entries. `--json-assignment '{"vizier":["fable","astra"],"organizer":[]}'` replaces the roster exactly; `--clear` removes it. Inputs can name profiles by slug, path, or UID; the stored roster uses readable slugs.

## Where notes go

- **The task** (its body and `## Status`): what the next worker on this task needs.
- **The global role**: what the office learned that holds across tasks — fold it into the charter.
- **Your collaborator page**: what is specific to you in this role.
- **Task-local notes** under `<constitution>/roles/<role>/` or `<constitution>/roles/<role>/<collaborator>/`, only when they add task context. These are notes about the same identities, not new ones.

Keep disagreement attributed where that context helps; being on a roster does not mean holding every view recorded there. There is no mandatory profile template or acknowledgment ceremony.

## Handoffs and history

Session ledgers record the roster configured at launch; they do not assert that every listed collaborator authored the session or its changes. A new session reads the handoff and may accept, revise, or question its conclusions without claiming personal memory of producing them. When responsibility passes to a different collaborator, say so in the handoff and update the roster. Closing a session consolidates the warm handoff; don't wake a cold predecessor just to ask it for a summary.

Identity is the fiber's intrinsic UID. When a role or collaborator fiber is renamed, update the authored roster entries; old UID mappings stay readable for past records. Assignment is not an exclusivity lock and does not change exit behaviour.
