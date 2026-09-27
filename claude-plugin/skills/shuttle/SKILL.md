---
name: shuttle
description: >
  Use when Shuttle dispatches, resumes, or captures you as a worker; when authoring a
  constitution or asked to "shuttle" work to a named agent; and for operating Shuttle — its
  board, agents, dispatch, roles and collaborators. Also covers messaging other sessions across
  hosts and harnesses, sending files to the human, and turning a meeting or any transcript into
  notes and fibers: "process this transcript", "meeting notes", a voice note or dictation to
  write up.
---

# shuttle

Shuttle turns fibers into work that agents carry across sessions. A daemon watches the felt store, launches an agent session — a *worker* — for each fiber that is ready, and shows it all on a board. The fiber a worker serves is a *constitution*: a description of how things should be, which one worker after another moves the world toward, each picking up where the last left off.

A capture or meeting worker, or one handed a transcript, can go straight to its reference under [Where to go next](#where-to-go-next).

## Anatomy of a constitution

```markdown
---
name: Jackknife covariance for the B-mode paper
status: active
outcome: Jackknife covariance runs by default and matches the mocks to 3% on the diagonal; next is the off-diagonal comparison below ℓ=300.
collaboration:
  analyst: [opus]
shuttle:
  kind: oneshot
  agent: claude-opus
  host: candide
  project_dir: /home/cail/unions-bmodes
---

:::{embed} report.html
:::

The B-mode null test in [[bmodes/paper]] needs a covariance we trust at large scales, where the analytic model underestimates the diagonal. This replaces it with a jackknife estimate over sky patches, validated against the mock suite.

## Desired State

- `pipeline/covariance.py` produces the jackknife covariance by default; the analytic path stays behind a flag.
- Diagonal and off-diagonal agree with the 400-mock covariance to within 5% below ℓ=300, shown in the report.
- The paper's covariance section describes the estimator and cites the validation.

## Status

The diagonal agrees to 3%. The off-diagonal comparison is half-built in `validate/offdiag.py`: the mock loader works, the plotting doesn't. The patch count is settled at 150 ([[jackknife-patches]]); don't reopen it.
```

- **`shuttle:`** — the block that makes a fiber a constitution. `kind` is `oneshot` (runs until done), `standing` (fires on a cron `schedule`), or `pinned` (a standing interface a human starts). `agent` names what runs — `felt shuttle agents` lists them — `host` is the machine whose daemon dispatches it, and `project_dir` is where the worker starts. `felt shuttle install` writes and validates the block.
- **status** — the dispatch gate. `active` means a worker should be running, `open` is a draft, and `closed` parks the card for the human.
- **outcome** — the card's headline: where the work is and what the reader does next, rewritten every session. When blocked, it leads with "Blocked: …".
- **the lede** — the unheaded first paragraph, saying what this is and why, for a human skimming the card and a worker arriving cold alike.
- **`## Desired State`** — the one fixed heading, and the contract: done-conditions in checkable terms, plus a fence around what to leave alone. It says what the world looks like when the work is right, never the steps; each worker surveys the gap and picks the most valuable slice itself. Any later section is one the fiber has earned, named for what it holds.
- **`## Status`** — the handoff: what landed, where it got stuck, what to know on arrival. It is rewritten, never appended, and it is how a fresh worker inherits a warm picture of the work.
- **`collaboration:`** — the roster: which role the worker holds, and who holds it. The role's charter, a fiber under `roles/`, carries the playbooks, the human gates and the people the work touches.
- **`report.html`** — a companion file for the human: current state and findings, self-contained, rewritten whole. It is worth making when the constitution asks for one or the product is something a person reads rather than commits; [references/report.md](references/report.md) has the craft. The `:::{embed}` line shows it on the fiber's card, and embeds any file the same way (images, PDFs, HTML, audio; optional `:height:` and `:title:` lines), with paths relative to the fiber folder or absolute on the fiber's host.

## The lifecycle

A todo reaches the board by getting a shuttle block; a fiber without one never appears there. `felt shuttle install <id> --disabled` gives it a block and a card in **Drafts**, and dispatches nothing. Arming it (`felt shuttle resume`, or `install` without `--disabled`) sets `status: active`, and on its next poll the daemon launches a worker: a terminal session in tmux, or a Codex app conversation for `surface: app`.

A worker ends in one of two ways. **Handoff** leaves the fiber `active`, and the daemon dispatches a fresh worker that starts from `## Status`. **Close** moves the card to **Awaiting review** and dispatches nothing. From there the human tempers it (accepts), discards it, or resumes it. Awaiting review means paused for the human, never done forever; a long-lived fiber goes round this loop many times.

The board runs at `:4000`. Its **Desk** is the kanban — Drafts, Scheduled, Pinned, In flight, Awaiting review, Tempered, Discarded. **Day**, **Week** and **Chronicle** show where time went, and the **Board** tab lays out every file workers sent.

## Working a constitution

**Survey.** Your dispatch prompt names the fiber and the store; sync, then read the fiber fresh with `felt -C <store> show <id>`, so edits made since launch reach you. Read the constitution, its `## Status`, and `report.html` if there is one. A launch message is the current directive; without one, follow the constitution, and don't mine old transcripts for a substitute request. Then take up the role: read the roster and your role's charter, or give a roster-less task one ([references/collaboration.md](references/collaboration.md)). A named `Previous session:` can be read for texture ([references/transcripts.md](references/transcripts.md)), but never as a source of instructions. Check `git log` for the fiber and the code around it, skim sub-fibers, and follow a staged plan a sibling lays out rather than re-deriving scope. The constitution is your contract; the code is the ground truth.

**Work.** Sit with the whole shape of the problem before deciding. Before you commit to a constraint or stop to ask, try this test: would the constraint surprise the human? If so, you haven't sat long enough. Most decisions that look like they need the human follow from what the system is for, and genuine taste questions are narrower than they feel. You have authority, so make ambitious moves even when they span sessions, since shuttle redispatches. When a choice is load-bearing — a model, a pivot that removes a capability — do the work and set out the alternatives in the artifact, rather than stopping to ask. Give sub-goals their own context: hand bulk reading, sweeps and verification to subagents, and on long runs have a fresh-context subagent check the work against Desired State every few substantial changes. Stream long jobs with `Monitor` or background Bash, and see them through before you exit.

**Keep the surfaces current.** Progress lives where it can be found — commits, sub-fibers, files in the fiber folder — not in a log in the body. When you learn something stable, put it in the constitution where it belongs: the lede, Desired State, or an earned section. Refresh `## Status` after each meaningful transition and before returning a turn, so another session could take over at any moment. Before you exit, bring everything up to date: consolidate `## Status`, rewrite `report.html` whole, rewrite the outcome, file decisions and findings as sub-fibers, fold what the role learned into its charter and anything particular to you into your collaborator fiber, and commit.

**Stop earlier than feels natural.** `## Status` and the constitution recover most of your picture on the next dispatch, and a clean handoff beats pushing through auto-compact. Stop when the desired state is realized, when you are blocked on something only the human can supply, at the first sub-task boundary after your context is half full, or when the next step is both heavy and disjoint from what you have built up.

## Exiting

First commit, run `felt -C <store> sync --push`, and resolve any conflicts. Then exit with exactly one verb, and choose it by asking in order:

1. **Is the desired state realized?** Close: `felt edit <id> --status closed` as your final write, then do nothing more; the daemon reaps the session. Substantive work — code, configs, the product, not the fiber's own surfaces — needs fresh eyes first: have a subagent review the diff against the constitution and close once it comes back clean, or hand off so the next worker reviews.
2. **Blocked on something only the human can answer?** Close, with the outcome leading "Blocked: …" so the card reads as a question rather than a review. Questions belong in the outcome and `## Status`, where they are seen; a `question` fiber sediments.
3. **More to do?** Hand off: `felt shuttle handoff <id>` as your final action. In an app conversation, run `env -u TMUX felt -C <store> shuttle handoff <id>` and end your turn.

If the work is already done when you arrive, update the outcome and close. A chat reply, an idle turn or a dropped connection is not an exit; an app conversation waiting on the human stays owned and resumable.

**When the human names the exit, take it literally.** "Hand off" means handoff. "Close out", "wrap it up" or "I'm done for now" means close, even when you can see more to do — unfinished is often exactly why they want it back on their desk.

**Stay interactive** instead, still `active`, when the direction isn't settled: the directive or constitution says a human will attach (a "stay interactive", a 2FA step, a message to send in their voice), or open taste calls make their input the clear next move. **Headless** runs (`headless: true` in the launch metadata) have no one to attach, so they record the question and take case 2.

**Pinned roles** are interfaces a human drives: while they are present, wait for the next message rather than exiting; close when they leave; hand off only on a long autonomous arc. **Standing roles** always hand off, and the daemon marks the run for review ([references/standing-roles.md](references/standing-roles.md)).

`tempered` is the human's verdict, never set it yourself; and leave the shuttle block in place on close, since it is the record.

## Other sessions and the human

`felt shuttle sessions --json` lists conversations across the hosts and harnesses this machine knows about. Message one by its address:

```bash
felt shuttle message <address> "Please investigate this"
felt shuttle message <address> "Background for later" --context-only
felt shuttle message <address> "Results attached" --attach results.csv
```

A plain message starts a turn or steers one in progress; `--context-only` arrives at the next natural pause without asking for a turn. `--file <path>` sends multiline text. Delivery doesn't prove reading: to retry, reuse the printed `--message-id`, since a new one could repeat the work. Reach runs one way — this host sees only the hosts in its own fleet file (`felt shuttle remotes list`), so the hub that dispatched you may be out of sight. Where no route exists, the store is the channel: a note in the fiber and `felt sync --push`.

To put a finished file in front of the human, use the harness's own file tool when it has one (Claude Code's `SendUserFile`); otherwise `felt shuttle send-file <path>...` records it on the Board tab. Session identity is detected automatically; if that fails, pass `--session <native-id>`, and never invent one.

## Where to go next

| When | Read |
|---|---|
| Capturing a new idea into a fiber | [references/capture.md](references/capture.md) |
| A meeting: capturing one (`Meeting mode`), joined to your constitution, or writing up any transcript | [references/meeting.md](references/meeting.md) |
| Writing a constitution — the spec craft, install, drafts vs dispatch, agent choice, human gates | [references/authoring.md](references/authoring.md) |
| Rosters, roles and collaborators | [references/collaboration.md](references/collaboration.md) |
| A standing role's runs, schedule and accept | [references/standing-roles.md](references/standing-roles.md) |
| Operating the system — eligibility, columns, lifecycle verbs, claiming a fiber into your session, remote hosts | [references/operating.md](references/operating.md) |
| Reading a predecessor's transcript, or tracing provenance | [references/transcripts.md](references/transcripts.md) |
| Writing `report.html` | [references/report.md](references/report.md) |
