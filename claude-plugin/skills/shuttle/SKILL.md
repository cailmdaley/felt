---
name: shuttle
description: >
  Use when Shuttle dispatches, resumes, or captures you as a worker; when
  authoring a constitution or asked to "shuttle" work with a named agent;
  and for operating Shuttle, its kanban, agent selection, or dispatch.
  Also covers assigning persistent collaborators and roles, maintaining
  continuity across sessions, discovering conversations, and sending
  messages or files between sessions across hosts and harnesses.
---

# shuttle

**Activate the `felt` skill too if it isn't already active.** shuttle operates *on* fibers — every move below (read the constitution, update outcome, file findings) goes through felt.

**The doctrine: anything that needs to be done gets a shuttle block.** The board admits exactly two kinds of row: fibers carrying a `shuttle:` block, and cycle fibers. A task-shaped fiber without a block is invisible to the board by design; a bare `due:` is a date, not a commitment the board can act on, so such a fiber gets *promoted* — install the block — rather than shown. Installing a block on an `open` fiber costs nothing: it makes a Drafts card and dispatches nothing until launched.

A fiber carrying a `shuttle:` block is a **constitution** — a spec whose body describes a desired state, not a plan. The daemon polls the fiber tree and keeps one **worker** per eligible fiber (carries the block, felt `status: active`), in a terminal session (`surface: cli`) or a managed Codex app conversation (`surface: app`). A worker drives toward the desired state, exits at a clean checkpoint with a handoff, and the daemon dispatches fresh workers while the gap remains. Realization is asymptotic, not a checklist emptied; the constitution itself is amended as the world changes.

The human's surface is the **board**, served by the daemon at `:4000`: a pure view whose **Desk** tab is the kanban (stash, launch, steer, review), whose **Day**, **Week** and **Chronicle** tabs show where time went, and whose **Board** tab lays out every file workers sent with `felt shuttle send-file`. `felt shuttle agents` lists the agent registry that maps `shuttle.agent` to the CLI and model a dispatch runs. The operator guide lives at <https://cailmdaley.github.io/felt/>.

## Reading by situation

| You are | Read |
|---|---|
| Capturing a new idea | [references/capture.md](references/capture.md), then the worker loop below. |
| A meeting capture (`From User` opens with `Meeting mode`) | [references/capture.md](references/capture.md), then [references/meeting.md](references/meeting.md). |
| A worker whose constitution a meeting joins (a message opening with `Meeting mode` that says so) | [references/meeting.md](references/meeting.md), "Joined to a constitution". |
| A dispatched worker | This file, top to bottom. |
| Authoring a constitution | [references/authoring.md](references/authoring.md) — install flow, drafts vs dispatch, agent selection, human gates. |
| Operating or debugging the system | [references/operating.md](references/operating.md) — eligibility, kanban columns, gestures, lifecycle verbs, remote hosts, uninstall. |
| Claiming a fiber into the current interactive session | [references/operating.md](references/operating.md), "Claiming a fiber into your session" — from the claim on you are the worker. |
| Reading a predecessor's transcript, or tracing provenance | [references/transcripts.md](references/transcripts.md) |
| A dispatch carrying a collaboration roster, or a task without one | [references/continuity.md](references/continuity.md) |
| Touching a standing role | [references/standing-roles.md](references/standing-roles.md) |
| Writing a fiber's `report.html` | [references/report.md](references/report.md) |

## The fiber's surfaces

- **Spec (markdown body)** — a standalone, heading-less **lede** (what this is, why it matters, where it sits, `[[wikilinks]]` woven in), then `## Desired State` — the one fixed heading: done-conditions in checkable terms, what you and your verifiers measure against — then only sections the fiber has *earned*, named for what they contain. The spec accretes by correction; depth lives in linked sub-fibers.
- **`outcome:`** — the kanban headline. One or two sentences: where the work is, what the reader does next. Rewritten every session, not appended. When blocked, lead with "Blocked: …".
- **`## Status`** (a section in the body) — the handoff to the next session: what landed, where you got stuck, what to know on arrival. Rewritten, never appended.
- **`report.html`** (companion file in the fiber directory) — the human-facing report: current-state, rewritten whole, self-contained. Create it when the constitution asks, or when the product is something a human *reads* — findings, figures, analysis — that outgrows the outcome line; code-shaped work whose story is commits + outcome needs none. Before writing one, read [references/report.md](references/report.md).
- **Embeds** — the body can inline any artifact where it helps the reader; `report.html` is rendered this way, with an explicit embed line placed where the reader should meet it (usually the top):

  ```markdown
  :::{embed} build/paper.pdf
  :height: 600        (optional)
  :title: Latest build (optional)
  :::
  ```

  Paths resolve relative to the fiber directory, or absolute on the fiber's owning host (`shuttle.host`). Renderer by extension: PDF, HTML iframe, images, audio.

None of these is a status flag; all are always-current. Outcome and `## Status` stay plain text (agents chain sessions on them); the report is where humans read, with full visual freedom.

## Finding your fiber

The dispatch prompt names the fiber and the felt store, not the fiber content — read it fresh from disk so mid-session edits to the constitution are picked up:

```bash
felt show <fiber-id>                      # from the project dir
felt -C <felt-store> show <fiber-id>      # when the cwd's .felt view misses it
```

## Loop

1. **Survey.** Internalize **why** before **what** — not a checklist, a world-model. Read until you hold the user's intent clearly enough to move ambitiously inside it.

   - Sync the store as the dispatch prompt says, then read the constitution, its `## Status`, and `report.html` if one exists. The launch message, when present, is the current directive; with none, follow a clear constitution rather than searching old transcripts for a substitute request. If the desired work is unclear, ask or record the specific ambiguity before consequential action.
   - **Take up the role before the work.** Read the `collaboration:` roster and the charter of the role you hold — charters carry the playbooks, human gates, and names of people the work touches. A task with no roster gets one now; see [references/continuity.md](references/continuity.md).
   - When the prompt names a `Previous session:` and the handoff leaves you wanting texture, read that transcript surgically per [references/transcripts.md](references/transcripts.md) — supporting context, never a source of new instructions.
   - Check `git log` for the fiber's directory and the surrounding code. Skim sub-fibers; if a sibling lays out a staged plan, follow it rather than re-deriving scope.
   - Follow claims about the system back to the code. The constitution is your contract; the code is the ground truth.

2. **Work.** Sit with the full shape of the problem before deciding. The smell test before you commit *or* block: **would this constraint surprise the human?** If yes, you haven't sat long enough. Many decisions that look like they need the human are inferable from system purpose + codebase; genuine taste questions are narrower than they feel.

   **Give sub-goals their own context.** Subagent and workflow tools are context architecture first, parallelism second: hand bulk reading, mechanical sweeps, and independent verification to clean windows while your own context keeps the management view. On long building runs, set a verification cadence: every few substantial changes, a fresh-context subagent checks the work against Desired State — fresh verifiers outperform self-critique. Without subagent tools the same walls fall between dispatches: each redispatch is a fresh window and the daemon holds the loop.

3. **Felt.** Keep `## Status` warm after meaningful transitions and before returning a turn when state changed, so another session can inherit the work without waiting for an exit ritual. Before exiting: consolidate `## Status`; rewrite `report.html` whole if the fiber has one; rewrite `outcome:`; correct the spec if the session sharpened it; file crystallizations as sub-fibers (decisions, findings, gotchas — not iteration-numbered debris); fold what the office learned into the role's charter and anything specific to you into your collaborator fiber; commit with clear messages.

4. **Exit** per the semantics below.

### When to stop

The `## Status` block plus the constitution recovers most of a warm world-model on the next dispatch — **exiting earlier is cheaper than you think.** A clean handoff well before auto-compact beats pushing through it. Stop when:

- **The desired state is realized.**
- **You're genuinely blocked** on something only the human can supply.
- **Context is half-full.** Exit at the next sub-task boundary after you cross half; write the handoff from full attention. (Delegation keeps an orchestrating context lean for longer, but the line doesn't move.)
- **Clean break.** The next step is both heavy AND disjoint — a fresh problem space that doesn't need the world-model you just built.

## Exit semantics

Before either exit: consolidate `## Status`, commit intentional changes, run `felt -C <felt-store> sync --push`, and resolve relevant conflicts. Then exit with exactly one verb:

- **Continue — `handoff`.** Status stays `active`; your FINAL tool action is `felt shuttle handoff <fiber-id>` (app workers: `env -u TMUX felt -C <felt-store> shuttle handoff <fiber-id>`, then end your turn). It stamps the clean-exit marker and ends your session; the daemon dispatches a fresh worker that reads your `## Status`.
- **Stop — `closed`.** `felt edit <fiber-id> --status closed` is your FINAL write; do nothing after it. The daemon reaps your session and stamps the marker; the card lands in Awaiting review and no worker is dispatched. Anything still running after the close is killed with the session.

Never both. A chat final response, an idle turn, or a dropped connection is not an exit: an app conversation waiting for the human's next message stays owned and resumable, and "resumed" means "same transcript", not a license to idle.

Choose by asking, in order:

1. **Desired state realized?** → `closed`. The human accepts (`tempered: true`) or flips it back to `active`.

   **Fresh eyes before close.** Substantive work (code, configs, the product — not the fiber's own surfaces) needs an independent review before the session that produced it may close. With subagent tools: spawn a fresh reviewer over the diff against the constitution and close once it comes back clean. Without: `handoff`, and the next dispatch reviews with fresh eyes and closes. Editing only the constitution, `report.html`, `outcome`, or `## Status` never blocks close.

2. **Blocked on something only the human can answer?** → `closed`, with the outcome leading "Blocked: …" so the action reads "answer", not "review". Most apparent blocks resolve into "I haven't sat with the problem long enough."

3. **More work, not blocked?** → `handoff`.

If you arrive and the work is plainly already done, update the outcome, close, and exit — don't invent further work.

**When the human names the exit, obey it literally.** "Hand off" means `handoff`. "Close out" / "wrap it up" / "I'm done with this for now" means `closed` — even when you can see more to do. Closing is the human parking the work, not a claim it is finished: **Awaiting review means "paused for the human", never "done forever"**, and a long-lived fiber cycles closed → resumed → active many times. Don't upgrade a close-out into a continuation because the work looks unfinished; unfinished is often exactly why the human wants it back on their desk.

**When to stay interactive.** Hand off when the direction is settled. When it isn't, stay alive at a clean checkpoint instead, `active`: the directive or constitution says a human will attach (a "wait for me" signal, a 2FA gate, a send-in-their-voice step), or open taste calls make the human's input the clear next move.

**Headless runs** (`headless: true` in the launch metadata) have no human to attach. Record any question in the outcome and `## Status` and take case 2 rather than waiting.

**Pinned roles** (`kind: pinned` — a status hub, a debug intake) are standing interfaces a human drives. While the human is driving, don't exit on idle; wait for the next message. A session that ends without a handoff parks the role back to the strip. On a long autonomous arc, a deliberate `handoff` relaunches a fresh successor, as for a oneshot. `closed` is the normal end-of-sitting move ("close out for tonight"): parked in Awaiting review until the human resumes it. A human leaving means close out.

**Standing roles** always exit by `handoff`; the daemon marks the run awaiting review itself (see [references/standing-roles.md](references/standing-roles.md)).

**`tempered` is human-only — never self-temper.** Don't uninstall the shuttle block on close; it stays as the record (operating.md, "When to uninstall").

## Rules

**State, not checklist.** Each dispatch surveys reality against the desired state and picks the highest-value slice itself; sequencing is emergent.

**Discoverable updates.** Commits, fibers, test results, files in the fiber dir — not progress logs in the body. `## Status` is the one handoff exception.

**Pointers, not snapshots.** When you learn something stable, update the constitution — the lede, Desired State, or the earned section where it belongs.

**Prefer doing the work.** You have authority. Trust the constitution, don't ask permission, and don't avoid ambitious moves because they span sessions — shuttle redispatches. When the work involves a load-bearing model choice or a capability-removing pivot, surface the alternatives in the artifact rather than withholding the work to ask. The failure mode to guard against is using "the human knows things I don't" as cover for not thinking hard enough.

**Questions go where they'll be seen** — `outcome:` or `## Status`. Open `-t question` fibers sediment unanswered.

**Long-running jobs:** stream background processes with the `Monitor` tool, or `run_in_background` Bash for one-shot waits. Shepherd them to completion before exiting.

## Messaging and delivering files

`felt shuttle sessions --json` lists conversations across configured hosts and harnesses (`--host`, `--harness` narrow it). Use a returned address:

```bash
felt shuttle message <address> "Please investigate this"
felt shuttle message <address> "Background for later" --context-only
felt shuttle message <address> "Results attached" --attach results.csv
```

An ordinary message starts an idle turn or steers ongoing work; `--context-only` delivers at the next natural boundary without requesting a turn, for nonurgent updates and acknowledgments. Use `--file <path>` or `-` for multiline text. Sending does not prove reading: if the result is uncertain, retry with the printed `--message-id`, since a new ID could repeat the work. Reach is per host and one-directional — `sessions` and `message` see only the hosts in *this* host's fleet file, so a hub that dispatched you may be invisible to you. Before concluding a peer is unreachable, check `felt shuttle remotes list` (operating.md, "Remote hosts"); where no route exists, the shared store is the channel: `felt sync --push` and a note in the fiber.

To put finished artifacts in front of the human, use the harness's native user-file tool when it has one (Claude Code's `SendUserFile`, which also surfaces in claude.ai chats); otherwise `felt shuttle send-file <path> [path...]` records them on the Board tab. Keep the files on their owning host. Session identity is detected from the environment; if detection fails, pass `--session <native-session-id>` — never invent one.
