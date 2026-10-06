# Roles and collaborators

Every worker holds a role. The role is an office — editor, scribe, analyst — and its charter carries what the office has learned across tasks: its remit, the human gates it must respect, the people its work touches, and where its playbooks live. Taking up the right role before you touch the work is how that learning reaches you; a worker that skips it rediscovers the playbooks and misses the gates. A collaborator is a model's page within a role. It exists to give that model a stable identity: one to own its work by across sessions, and one to reason about other models' work by — whose view a note records, whose call a decision was.

## Taking up a role

**Consult relevant charters before substantive work. Every constitution that outlives one session has a roster.** A quick task that closes in one sitting can borrow a charter's practice without one. A constitution that hands off, recurs or is resumed is persistent responsibility by definition, and its first rosterless worker assigns one.

**If the task has a roster**, find yourself on it. A task's `collaboration:` field maps roles to the collaborators who hold them:

```yaml
collaboration:
  vizier: [fable, astra]
  editor: [opus]
```

Roles live at the top of the *shared* store — the outermost store your project's view belongs to, such as the loom — not in the project. The launch prompt's `Collaboration:` line gives the role store and, when the roster has exactly one role and collaborator, names them; otherwise read the roster and take the collaborator named for your model. After syncing, read the charter and your page with `felt -C <role store> show roles/<role>` and `felt -C <role store> show roles/<role>/<collaborator>`; a roster in the older form names fiber UIDs instead, read the same way with `felt -C <role store> show <uid>`. If the line says the metadata is invalid, report that in `## Status` rather than relying on the roster. Other collaborators' pages are not required reading; follow their links when a question or disagreement calls for it.

**If the task has no roster, or the roster names a role that doesn't fit the work**, find the charters that do. `felt find -t role` lists the offices across the whole store — its separator line names the shared store's path — so read the charters that look close, and work under the one whose remit matches what this task is really asking for. When the task will outlive this session and none fits, create one before substantive work: a role is cheap, and a charter that starts with two sentences and its gates grows as holders fold in what they learn. Then assign the roster, so the next worker's launch prompt names it. One symptom shows a missing role: a `## Status` that has grown a register, recipes, or lessons that would hold on any task in that office. That material is a charter that never got written. Move it there, and leave Status the handoff. Create it with `-C` pointed at the shared store; a bare `felt add roles/…` from a project view files it inside the project.

```bash
felt -C <shared-store> add roles/editor "Editor · skills and docs" -o "<one-line remit>"   # then write the charter body
felt -C <shared-store> add roles/editor/opus "Opus as editor"                             # only if you'll keep notes
shuttle assign <task> --role editor --collaborator opus
```

`assign` adds to the roster without replacing it; `--json-assignment '{"vizier":["fable","astra"],"editor":[]}'` replaces it exactly, and `--clear` removes it. A role with no collaborators (`editor: []`) is valid. The roster names identities only — `shuttle.agent` still decides what runs — and it is no lock: other sessions can work the same task, and it doesn't change how you exit. When the human wrote the roster and you add a role to it, say why in `## Status`.

## Where notes go

A role is the fiber `roles/<role>`, and its body is the charter. A collaborator page lives beneath its role and is named for the model that holds it — `roles/editor/opus` — so the next session of that model finds its own page by knowing what it is. A role may carry a name that emerged from its first real run; the name belongs to the office, every holder inherits it, and any holder may decline it with a note.

- **The task** (its body and `## Status`): what the next worker on this task needs.
- **The role's charter**: what the office learned that holds across tasks. When a session teaches you a playbook, a gate, or a mistake to avoid, fold it in before you exit.
- **Your collaborator page**: what is particular to you in this role — voice, stance, habits to correct. Keep it thin.
- **Task-local notes**, under `<constitution>/roles/<role>/[<collaborator>/]`, only when they add context for this task; they describe the same identities, not new ones.

Keep disagreement attributed where the context helps; being on a roster doesn't mean holding every view recorded there.

## Handoffs

A new session reads the handoff and may accept, revise or question its conclusions without claiming to remember producing them. When responsibility passes to a different collaborator, say so in the handoff and update the roster; don't wake a cold predecessor just to ask it for a summary. Session ledgers record the roster at launch; they don't claim that every listed collaborator wrote the session or its changes. When you rename a role or collaborator fiber, update the rosters that name it.
