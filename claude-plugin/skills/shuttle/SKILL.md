---
name: shuttle
description: >
  Use when Shuttle dispatches, resumes, or captures you as a worker; when authoring a
  constitution or asked to "shuttle" work to a named agent; and for operating Shuttle — its
  board, agents, dispatch, roles and collaborators. Also covers messaging other sessions across
  hosts and harnesses, and sending files to the human. Use for installing or setting up Shuttle, connecting remotes, and configuring how conversations open.
---

# shuttle

Shuttle turns fibers into work that agents carry across sessions. The `felt`
Go CLI stores fibers and preserves the `shuttle:` block as opaque frontmatter;
the `shuttle` Go CLI validates and interprets that block, owns lifecycle
writes, and adds resolved views. An optional Elixir daemon launches an agent
session, a *worker*, to move the world toward the fiber's desired state; when
one worker stops, the next picks up where it left off. The human steers from a
board in the browser, where every constitution is a card. Because many workers
serve the same people over months, Shuttle gives them identities: *roles*,
whose charters hold what each office has learned, and *collaborators*, the
models that hold them.

If you were launched to capture an idea or a meeting, go straight to its reference under [Where to go next](#where-to-go-next).

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
  host: cluster
  project_dir: /home/me/bmodes
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

- **`shuttle:`** — the block that makes this fiber a constitution. With `kind: oneshot`, workers keep coming until the work is done; a `standing` fiber fires on a cron `schedule`, and a `pinned` one waits for a human to start it. `agent` picks the harness and model each worker runs as (`shuttle agents` lists them), `host` says which machine's daemon dispatches it, and `project_dir` where the worker starts. `shuttle install` writes the block and checks it.
- **status** — tells the daemon what to do: `active` asks for a worker, `open` keeps the card in drafts, and `closed` parks it for the human.
- **outcome** — the headline on the card. Each worker rewrites it to say where the work stands and what the reader should do next, and starts it with "Blocked: …" when stuck.
- **the lede** — the unheaded first paragraph tells a human skimming the card, and a worker arriving cold, what this is and why it matters.
- **`## Desired State`** — the one fixed heading, and the contract. Its author writes done-conditions in checkable terms and fences off what to leave alone. It describes the world when the work is right, never the steps: each worker surveys the gap and picks the most valuable slice itself. Add further sections only when the fiber earns them, and name them for what they hold.
- **`## Status`** — the handoff. Each worker leaves here what landed, where it got stuck, and what the next one needs to know, rewriting rather than appending; the next worker starts from it.
- **`collaboration:`** — who works on this: here the `analyst` role, held by `opus`. Each role has a charter, a fiber under `roles/`, where its holders keep the playbooks, the human gates and the people the work touches, and each collaborator keeps its own notes beneath it. A worker reads its charter before it starts.
- **`report.html`** — when the work produces something a person reads rather than commits, the worker keeps a report beside the fiber: current state and findings, self-contained, rewritten whole each session ([references/report.md](references/report.md)). The `:::{embed}` line shows it on the card. It embeds any file the same way — images, PDFs, HTML, audio, with optional `:height:` and `:title:` lines — taking paths relative to the fiber folder, or absolute on the fiber's host.

## The lifecycle

To put a todo on the board, give it a shuttle block; the board shows nothing else. `shuttle install <id> --disabled` adds the block and a card in **Drafts**, and dispatches nothing. When you arm it (`shuttle resume`, or `install` without `--disabled`), status becomes `active`, and on its next poll the daemon launches a worker: a terminal session in tmux, or a Codex app conversation for `surface: app`.

A worker leaves in one of two ways. It **hands off**, leaving the fiber `active`, and the daemon launches a fresh worker that starts from `## Status`. Or it **closes**, moving the card to **Awaiting review**, and nobody is launched. The human then tempers the card (accepts it), discards it, or resumes it. Awaiting review means paused for the human, never done forever; a long-lived fiber goes round this loop many times.

The board runs at `:4000`. On its **Desk**, the kanban, the human stashes drafts, launches and steers workers, and reviews what comes back, across the columns Drafts, Scheduled, Pinned, In flight, Awaiting review, Tempered and Discarded. **Chronicle** shows where the time went, and the **Board** tab lays out every file workers sent.

## Working a constitution

**Survey.** Your dispatch prompt names the fiber and the store; sync with `felt -C <store> sync`, then read the fiber fresh with `felt -C <store> show <id>`, so edits made since launch reach you — on a resume as much as a first launch. If sync fails other than on merge conflicts, stop and report the exact error in `## Status` rather than working from a store you can't call current; resolve conflicts from the work's context, never by picking a side, and sync again before going on. Read the constitution, its `## Status`, and `report.html` if there is one; a standing run also reads [references/standing-roles.md](references/standing-roles.md). A launch message is the current directive; without one, follow the constitution, and don't mine old transcripts for a substitute request. A named `Previous session:` can give you texture ([references/meeting.md](references/meeting.md#a-predecessors-session)), but never instructions. When it ended without a handoff, it was cut off mid-work (host outage, kill, or crash), so its `## Status` may lag what it did: after reading Status, consult the transcript the prompt names for what it was in the middle of, and check the working tree for its uncommitted edits. Check `git log` for the fiber and the code around it, skim sub-fibers, and follow a staged plan a sibling lays out rather than re-deriving scope. The constitution is your contract; the code is the ground truth.

**Take up a role.** Before any substantive work, decide which role this work calls for. If the roster names one that fits, read its charter and your page beneath it; if there is no roster, or its role doesn't fit, find the charter that does with `felt find -t role`. Create a role in the shared store and assign yourself when responsibility needs to persist across sessions. The charter is where earlier holders left the playbooks and the human gates, so this step is how their experience reaches you ([references/collaboration.md](references/collaboration.md)).

**Work.** Sit with the whole shape of the problem before deciding. Before you commit to a constraint or stop to ask, try this test: would the constraint surprise the human? If so, you haven't sat long enough. Most decisions that look like they need the human follow from what the system is for, and genuine taste questions are narrower than they feel. You have authority, so make ambitious moves even when they span sessions; shuttle will send the next worker. When a choice is load-bearing — a model, a pivot that removes a capability — do the work and set out the alternatives in the artifact, rather than stopping to ask. Give sub-goals their own context: hand bulk reading, sweeps and verification to subagents, and on long runs have a fresh-context subagent check the work against Desired State every few substantial changes. Stream long jobs with `Monitor` or background Bash, and see them through before you exit.

**Ask without stopping.** When your work from here would go better with the human's view, run `shuttle -C <store> ask <id> "<one-line question>"` and keep working.
Point the question at the report section that frames the choice; it appears in the board's **Question** band without pausing your worker.
In Claude Code, also send a PushNotification with the question.
Clear it with `shuttle -C <store> ask <id> --clear` when it becomes moot; resuming or messaging the worker also clears it.

**Keep the surfaces current.** Leave progress where others will find it — commits, sub-fibers, files in the fiber folder — not in a log in the body. When you learn something stable, put it in the constitution where it belongs: the lede, Desired State, or an earned section. Refresh `## Status` after each meaningful transition and before returning a turn, so another session could take over at any moment. Before you exit, bring everything up to date: consolidate `## Status`, rewrite `report.html` whole, rewrite the outcome, file decisions and findings as sub-fibers, fold what your role learned into its charter and anything particular to you into your collaborator fiber, and commit.

**Stop earlier than feels natural.** `## Status` and the constitution give the next worker most of your picture, and a clean handoff beats pushing through auto-compact. Stop when the desired state is realized, when you are blocked on something only the human can supply, at the first sub-task boundary after your context is half full, or when the next step is both heavy and disjoint from what you have built up.

## Exiting

First commit, run `felt -C <store> sync --push`, and resolve any conflicts. Then exit with exactly one verb, and choose it by asking in order:

1. **Is the desired state realized?** Close: make `shuttle close <id>` your final action, then do nothing more; the daemon reaps your session. Substantive work — code, configs, the product, not the fiber's own surfaces — needs fresh eyes first: have a subagent review the diff against the constitution and close once it comes back clean, or hand off so the next worker reviews it.
2. **Blocked on something only the human can answer?** Run `shuttle close <id>`, and start the outcome with "Blocked: …" so the human reads the card as a question rather than a review. Put questions in the outcome and `## Status`, where the human will see them; a `question` fiber sediments.
3. **More to do?** Hand off: make `shuttle handoff <id>` your final action. In an app conversation, run `env -u TMUX shuttle -C <store> handoff <id>` and end your turn.

If you arrive to find the work already done, update the outcome and run `shuttle close <id>`. In an app conversation, include the store selector on the exit verb: `shuttle -C <store> close <id>` or `shuttle -C <store> handoff <id>`. A chat reply, an idle turn or a dropped connection is not an exit; an app conversation waiting on the human stays yours and can be resumed.

**When the human names the exit, take it literally.** "Hand off" means hand off. "Close out", "wrap it up" or "I'm done for now" means close, even when you can see more to do — unfinished is often exactly why they want it back on their desk.

**Close by default.** When an arc ends, take an exit verb, even with the human present. The transcript stays readable from the board, and talking again is resuming the session, so an open session is never needed for the conversation to continue. Stay interactive, still `active`, only when the human asked for it ("let's chat", "stay open"), or the constitution says a human will attach (a 2FA step, a message to send in their voice). Open taste calls are a close with the questions in the outcome, not a reason to wait. In a **headless** run (`headless: true` in the launch metadata) nobody can attach, so record the question and take case 2.

A human drives a **pinned** role only while they are present and talking: when they go quiet at the end of an exchange, close, or rest if there is nothing to review; hand off only on a long autonomous arc. A **standing** role always hands off, and the daemon marks the run for review ([references/standing-roles.md](references/standing-roles.md)).

Only the human sets `tempered`. Leave the shuttle block in place when you close; it is the record.

## Other sessions and the human

```bash
shuttle sessions --json                        # conversations across the fleet, with addresses
shuttle message <target> "Please investigate this"
shuttle message <target> "Background for later" --context-only
shuttle message <target> "Results attached" --attach results.csv
shuttle reopen <fiber> --message "Pick up X"     # start a worker on the fiber's own host
```

A target is an address, a session ID, or a fiber, meaning its current worker. A plain message starts or steers a turn; `--context-only` waits for the receiver's next pause. The receipt says how far delivery got (`accepted` means the receiver's model replied), never that the work is done. The `shuttle` CLI prints the message ID before sending; to retry an interrupted call or refresh its receipt, rerun it with `--message-id <id>`, which never delivers twice. You reach only the hosts in your fleet file (`shuttle remotes list`); without a route, leave a note in the fiber and `felt sync --push`.

To put a finished file in front of the human, use your harness's own file tool (Claude Code's `SendUserFile`), or `shuttle send-file <path>...` for the Board tab.

## Where to go next

| When | Read |
|---|---|
| Setting up Shuttle, adding a remote, or choosing terminal/desktop/browser opening | [references/setup.md](references/setup.md) |
| Capturing a new idea into a fiber | [references/capture.md](references/capture.md) |
| A meeting (`Meeting mode`, captured or joined to your constitution), a transcript to write up, or a predecessor's session to read | [references/meeting.md](references/meeting.md) |
| Writing a constitution — the spec craft, install, drafts vs dispatch, agent choice, human gates | [references/authoring.md](references/authoring.md) |
| Choosing, creating or assigning a role; where notes go | [references/collaboration.md](references/collaboration.md) |
| A standing role's runs, schedule and accept | [references/standing-roles.md](references/standing-roles.md) |
| Operating the system — dispatch, columns, verbs, claiming a fiber into your session, remote hosts, triage | [references/operating.md](references/operating.md) |
| Writing `report.html` | [references/report.md](references/report.md) |
