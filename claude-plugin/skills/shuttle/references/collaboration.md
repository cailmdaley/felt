# Roles and collaborators

Every worker holds a role. The role is an office — editor, scribe, analyst — and its charter carries what the office has learned across tasks: its remit, the human gates it must respect, the people its work touches, and where its playbooks live. Taking up the right role before you touch the work is how that learning reaches you; a worker that skips it rediscovers the playbooks and misses the gates.

## Taking up a role

Do this first, before substantive work, on every dispatch.

**If the task has a roster**, find yourself on it. A task's `collaboration:` field maps roles to the collaborators who hold them:

```yaml
collaboration:
  vizier: [fable, astra]
  editor: [opus]
```

When the roster has exactly one role and collaborator, the launch prompt names them; otherwise read the roster and take the collaborator named for your model. Read the role's charter, `roles/<role>`, and your own page, `roles/<role>/<collaborator>`, with `felt -C <store> show`. Other collaborators' pages are not required reading; follow their links when a question or disagreement calls for it.

**If the task has no roster, or the roster names a role that doesn't fit the work**, choose one. List the offices with `felt -C <store> ls roles`, read the charters that look close, and take the one whose remit matches what this task is really asking for. When none fits, create one: a role is cheap, and a charter that starts with two sentences grows as holders fold in what they learn.

```bash
felt -C <store> add roles/editor "Editor · skills and docs" -o "<one-line remit>"   # then write the charter body
felt -C <store> add roles/editor/opus "Opus as editor"                             # only if you'll keep notes
felt shuttle assign <task> --role editor --collaborator opus
```

`assign` adds to the roster without replacing it; `--json-assignment '{"vizier":["fable","astra"],"editor":[]}'` replaces it exactly, and `--clear` removes it. A role with no collaborators (`editor: []`) is valid. The roster names identities only; `shuttle.agent` still decides what runs.

## Where notes go

Roles live at `roles/<role>/` at the top of the shared store. A collaborator page lives beneath its role and is named for the model that holds it — `roles/editor/opus` — so the next session of that model finds its own page by knowing what it is. A role may carry a name that emerged from its first real run; the name belongs to the office, every holder inherits it, and any holder may decline it with a note.

- **The task** (its body and `## Status`): what the next worker on this task needs.
- **The role's charter**: what the office learned that holds across tasks. When a session teaches you a playbook, a gate, or a mistake to avoid, fold it in before you exit.
- **Your collaborator page**: what is particular to you in this role — voice, stance, habits to correct. Keep it thin.
- **Task-local notes**, under `<constitution>/roles/<role>/[<collaborator>/]`, only when they add context for this task; they describe the same identities, not new ones.

Keep disagreement attributed where the context helps; being on a roster doesn't mean holding every view recorded there.

## Handoffs

A new session reads the handoff and may accept, revise or question its conclusions without claiming to remember producing them. When responsibility passes to a different collaborator, say so in the handoff and update the roster. Session ledgers record the roster at launch; they don't claim that every listed collaborator wrote the session or its changes. When you rename a role or collaborator fiber, update the rosters that name it.
