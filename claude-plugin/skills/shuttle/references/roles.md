# Roles

Every worker holds a role. A role is an office, such as editor, scribe or surveyor. It is the fiber `roles/<role>` at the top of the shared store (the `Felt store:` your launch prompt names, such as the loom), and its body, the charter, carries what the office has learned across tasks: its remit, the human gates it must respect, the people its work touches, and where its playbooks live. Taking up the right role before you touch the work is how that learning reaches you. A worker that skips it rediscovers the playbooks and misses the gates.

## Taking up a role

**Read the charter before substantive work.** A constitution names its role in its shuttle block:

```yaml
shuttle:
  role: surveyor
```

After syncing, read it with `felt -C <store> show roles/<role>`. The role says what kind of work this is, not who you are: `shuttle.agent` decides which model runs, and the session ledger records who ran each session.

**If there is no role, or the role doesn't fit the work**, find the charter that does. `shuttle roles` lists the offices, and `roles/roles.md`, where the store keeps one, maps kinds of work to them. Read the charters that look close, and work under the one whose remit matches what this task is really asking for. A quick task that closes in one sitting can borrow a charter's practice without being assigned to it. A constitution that hands off, recurs or is resumed is persistent responsibility, and gets a role:

```bash
shuttle role <task> surveyor
```

When none fits, create one before substantive work. A role is cheap: a charter that starts with two sentences and its gates grows as holders fold in what they learn. `shuttle role <task> <role> --new "<Office name>"` creates the charter in the shared store's `roles/` and assigns it; then replace its placeholder body with the remit and gates, and add its row to `roles/roles.md` when the store keeps that map.

One symptom shows a missing role: a `## Status` that has grown a register, recipes, or lessons that would hold on any task in that office. That material is a charter that never got written. Move it there, and leave Status the handoff.

**A seat is a constitution that is the office itself**, not a task the office takes on: the cmbx chair, the vizier's desk. `shuttle seat <task>` sets `shuttle.seat: true` beside its role, and the board draws it at rest in the Roles band. Its playbooks, register and standing lessons belong in the charter; the seat keeps the lede, Desired State and Status. A role can have several seats, one per machine or stream.

## Keeping the charter

The charter is written for every holder, of whatever model. Fold in what a session taught you about the office — a playbook, a gate, a mistake to avoid — before you exit, and correct the charter rather than appending to it: a lesson goes where it belongs in the body, not into a log of sittings. What happened in a sitting belongs in the task's `## Status` and the session transcript.

Every model leaves its idiosyncrasies in what it writes: a register, a habit of emphasis, a stance that suited it. When the charter reads as another model's voice, or its last holders ran on a different model than you, reread it as an outsider before relying on it. Keep what holds for the office, rewrite what was one holder's manner, and cut what no longer helps. That pass is part of holding the role, not a detour from it.

A role may carry a name that emerged from its first real run (Boswell, Colbert). The name belongs to the office, every holder inherits it, and any holder may decline it with a note.

## Handoffs

A new session reads the handoff and may accept, revise or question its conclusions without claiming to remember producing them. Don't wake a cold predecessor just to ask it for a summary. When you rename a role, update the constitutions whose `shuttle.role` names it.
