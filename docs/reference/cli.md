# CLI Reference

This page covers both Go CLIs. `felt` creates, searches, and edits fibers;
`shuttle` interprets the optional `shuttle:` block and owns orchestration.
Scan for a command, then read its `--help` text for examples and detail.

Their global flags are separate:

| CLI | Flag | Purpose |
|---|---|---|
| `felt` | `-C, --directory <dir>` | Run as if felt was started in `<dir>` |
| `felt` | `-j, --json` | Output in JSON format |
| `shuttle` | `-C, --store <dir>` | Select a felt store root |
| `shuttle` | `-j, --json` | Output in JSON format |
| both | `-h, --help` | Show help for the command |

`felt --version` prints its build version. `shuttle version` reports the
running daemon's version when reachable, otherwise the local Mix release version.

## Core fiber verbs

| Command | Purpose |
|---|---|
| `felt init` | Create or repair the local `.felt/` directory and support files |
| `felt add <slug> <name>` | Create a fiber (`-b` body, `-o` outcome, `-s` status, `-t` tag, `-D` due, `-R` role, defaulting for open work to `git config felt.person`, `--top-level` to skip placing `<slug>` under an existing fiber of the same leading name; `--namespace` to create an exact path in the enclosing store, independent of the project view; `--uid` to carry an existing fiber under its intrinsic id and slug; it refuses a UID that any fiber of the enclosing store holds). Refuses a segment it creates outside [the slug convention](../concepts/fibers.md#the-slug-convention), naming the conforming form, and any segment starting with a dot, `--uid` or not |
| `felt edit <id>` | Modify a fiber's native metadata (`--name`, `-o`, `-s`, `-t`/`--untag`, `-b` body, `-D`, `-R` role, `--set`/`--unset` for opaque scalars) |
| `felt show <id>` | Show a fiber at a given detail level (`-d name\|compact\|summary\|full`; compact and summary report the body's line count; `--body`, `--citations`, `--consumers`, `--field <name>`; `--citations` and `--consumers` search the whole store; `--exact` accepts only a ULID or an exact enclosing-store path; `--path-hint <path>` verifies a UID at that exact path before walking for it) |
| `felt rm <id>` | Delete a fiber's file; nested fibers stay where they are. Refuses a guessed id (one resolving only by its last segment or as a prefix completion) and names the fiber it would have reached |
| `felt sync [--push]` | Fetch and merge the actual store repository's upstream; optionally publish committed work to that tracking branch. Leaves conflicts for contextual resolution and never stages, stashes, or force-pushes; a diverged upstream makes a merge commit. Then runs the same sync, `--push` included, once in each other git repository that a symlinked directory inside the store points into, naming each; a mount with no remote tracking branch is skipped with a note, a symlink outside git mounts nothing, and a failing mount is reported by its path after the rest have run, with a non-zero exit. `--fetch-timeout <duration>` bounds the network fetch (default: 2m); local merge has no hard deadline. Its last lines name every fiber in the store that no listing can read, with the parse error, and it then exits non-zero although the merge and push completed |

## Search and reading

| Command | Purpose |
|---|---|
| `felt ls [query]` | List and search fibers; plain queries search bodies by default, putting name/slug matches before metadata matches and marking body-dependent hits; `--no-body` restores metadata-only search, and `--body` includes matched bodies in JSON output. `--any field:<name>` / `--any tag:<tag>` (repeatable) admits fibers matching at least one any-filter, ANDed with every other filter; a query, tag, field, any-filter, or id-file filter searches every status but closed. `--ids-from <file>` reads canonical ids without a walk and preserves input order. `--json-field` projects JSON output; `--unreadable` adds, with `--json`, a row `{id, path, unreadable}` for each fiber file the walk could not read, in place of the fiber it holds; `-v` expands matches folded under a matching ancestor. Each line shows the fiber's `role` as `@<role>` before its tags, and every listing includes everyone's work; `--person <name>` keeps fibers whose `role` names that person (its last segment) |
| `felt roles` | List the offices: each charter at `roles/<office>` in the store that holds the charters, or `<mount>/roles/<office>` in a repository linked in at its top ([where a charter lives](../concepts/roles.md#where-a-charter-lives)). `--json` gives `slug`, `id`, `name`, `outcome`; `shuttle roles` is the same command |
| `felt find [query]` | Search the whole store, not just this view — local hits first under their local ids, then the rest of the enclosing store under a separator naming it, each by its full id there (those ids work as arguments to `show`, `edit`, `nest`, `rm`, `tree`). Takes `ls`'s matching and filters (`-t`, `-s`, `-r`, `-e`, `--body`, `--no-body`, `--has-field`, `--person`, `-v`, `--limit`, `-j`) |
| `felt session` | Print the SessionStart context as plain text |
| `felt tree [id]` | Show the containment tree, every status included (`-L`/`--depth` caps depth; elided branches show how much is below) |

## Structure

| Command | Purpose |
|---|---|
| `felt nest <child> <parent>` | Move a fiber subtree under a parent, keeping its basename and rewriting every reference the move would break (wikilinks, markdown links to fibers and to files, `inputs.from`), across the enclosing store too from a view (a repository a larger store links in is one when `git config felt.enclosing` names that store; see [cross-project stores](../concepts/cross-project.md#the-project-as-canonical)); refuses a guessed id. Use `rename` to change the basename |
| `felt rename <id> <new-slug>` | Change the directory and document basename, preserving the intrinsic id and carrying descendants and references (wikilinks, markdown links to fibers and to files, `inputs.from`), including across linked repositories and, from a repository whose `git config felt.enclosing` names the store that links it in, across that store. Refuses a new slug outside [the slug convention](../concepts/fibers.md#the-slug-convention), naming the conforming form; the fiber renamed may have any slug. Refuses an id it would have to guess at (a prefix or a stale path), existing destinations, and companion-file collisions. Lists the fibers whose text still holds the old path for manual review; does not rewrite prose or opaque project fields |
| `felt unnest <child>` | Move a nested fiber subtree to the top level, rewriting and refusing as `nest` does |
| `felt recover-move [--abandon]` | Finish an interrupted subtree move's reference repairs; `--abandon` drops the journal without undoing the move or repairing remaining references |

Live Shuttle workers keep their existing terminal names after a rename; the daemon identifies them by the intrinsic id, not the current leaf.
Moves refuse bare-form namespace entry points (`.felt/<slug>.md` or `<mount>/<slug>.md`) before writing a journal; put their documents in directory form before moving them.
Interrupted moves retain `.move-pending.json` in the store.
Repeat the same `nest`, `unnest`, or `rename` command with either endpoint spelling of the child, or use `recover-move` there.
A divergent reference document is refused rather than overwritten; resolve it before retrying, or abandon recovery and repair it by hand.
Store support files `*.md.lock`, `.*.tmp` and `.move-pending.json*` belong in `.felt/.gitignore`; `felt init` repairs those entries.

## Maintenance

| Command | Purpose |
|---|---|
| `felt check` | Report unparseable fibers, empty names, broken wikilinks, `inputs.from` refs, stale link paths, legacy forms, slug collisions, stray fiber files; exits non-zero on errors. Warns about each fiber outside [the slug convention](../concepts/fibers.md#the-slug-convention) |
| `felt migrate` | Normalize legacy storage into the current model, folding stray fiber files into their directories; exits non-zero when a stray cannot fold safely (`--dir`, `--dry-run`) |
| `felt backfill-ids` | Assign ULID ids to fibers missing one (`--dir`, `--dry-run`) |

## Setup / update

| Command | Purpose |
|---|---|
| `felt setup claude` | Install the felt plugin for Claude Code (`--source`, `--uninstall`) |
| `felt setup codex` | Install the felt plugin for Codex (`--source`, `--uninstall`) |
| `felt setup pi` | Install the felt package for pi from the promoted generation (`--source`, `--uninstall`) |
| `felt setup antigravity` | Install the felt plugin for the Antigravity CLI at `~/.gemini/config/plugins/felt/` from the promoted generation (`--source`, `--uninstall`) |
| `felt setup receipt` | Report the Felt executable and promoted/loaded harness generations, hooks, and pending plugin-promotion state (`--json` for the machine-readable receipt, where each bundle's `inspection` is `confirmed` by the harness's plugin list, `configured` from its config and cache alone, or `unknown`) |
| `felt setup skills` | Link felt skills into a target directory (`--source`, `--target`, default `~/.claude/skills`) |
| `felt setup validate --source <checkout>` | Non-mutating validation of a complete local plugin candidate, including both skills and registered hook files |
| `felt uninstall` | Remove the felt plugin from Claude Code and Codex and the felt package from pi (inverse of `setup claude`/`codex`/`pi`) |
| `felt update` | Update the `felt` and `shuttle` Go binaries together, then refresh the Claude Code plugin and any installed Codex or pi integration to the matching tag. When a Shuttle daemon on the host is running or installed at another version than the new CLIs (for a checkout-built daemon, running at another contract level), it prints both versions and the command that brings the daemon level (`shuttle daemon check`); it does not change the daemon |

## `felt hook` (agent-harness adapters)

These commands wrap the primary verbs above for agent harnesses, not for
people.

| Command | Purpose |
|---|---|
| `felt hook session` | Emit the SessionStart `additionalContext` envelope |
| `felt hook pretool` | PreToolUse gate: deny non-felt tool calls until the felt skill activates |
| `felt hook posttool` | PostToolUse: stamp `updated-at` when an agent edits a fiber file directly; when the edit leaves the fiber's markdown unreadable, answer with a block naming the parse error instead |

## Session transcript search

`shuttle find "<query>"` searches fibers and transcripts in one call: `felt find`'s fiber hits over the whole store, every status included, then the transcript search's session hits below. Each session prints its date, title and fibers, its best passage (from the main thread when the main thread matches), and an address `<session>[/<agent>]:<line>`. `shuttle show <address>` prints the conversation around that line, tool calls folded to their names, with earlier and later addresses; `shuttle show <session>` outlines the human's turns and the last reply. A fiber id always wins over a bare session prefix. It takes `felt find`'s flags, plus `--since` and `--harness` for the sessions; `--limit` caps both blocks, and `--json` returns `{query, fibers, transcripts, index, errors}`. A regex or a query-less filter skips the sessions; a half that fails is reported under `errors` while the other still answers.

`shuttle transcript <session-id>` resolves a transcript's native path, materializing a remote transcript into the local cache when needed.
The same command family searches local Claude Code, Codex, Pi and Antigravity JSONL transcripts:

```sh
shuttle transcript index                 # incremental catch-up
shuttle transcript index --rebuild       # discard and rebuild
shuttle transcript search "socket timeout" --since 30d
shuttle transcript search "worker launch" --fiber constitutions/worker-threads
shuttle transcript search "retry" --session <uuid> --harness codex -n 5
```

The daemon builds and refreshes the transcript index in the background.
If the index isn't ready, search reports that it needs a completed build; without a running daemon, run `shuttle transcript index` manually.
Search doesn't silently start a first full build.
Subsequent searches catch up changed transcripts unless `--no-index` is supplied.
A populated index built from individual files can be searched with `--no-index`, but automatic catch-up requires a completed root scan.
The index is private, rebuildable cache data at `$XDG_CACHE_HOME/felt/transcript-index.sqlite`, defaulting to `~/.cache/felt/transcript-index.sqlite`; `SHUTTLE_TRANSCRIPT_INDEX` selects another file.
Transcript roots can be overridden with `SHUTTLE_CLAUDE_PROJECTS_DIR`, `SHUTTLE_CODEX_SESSIONS_DIR`, and `SHUTTLE_PI_SESSIONS_DIR`.

Results rank by SQLite FTS5 BM25 relevance, with user and assistant message scores multiplied by 1.5 and tool scores unchanged.
For example, raw relevance 10 becomes 15 for conversational text; a tool match scoring 16 still wins, while a tool match scoring 12 doesn't.
This favors conversations over similarly relevant tool echoes without removing tool-only matches.
The role multiplier applies before the result limit, and returned scores include it (higher is better).
Messages beginning with `[external_agent_tool_result]` or `[external_agent_tool_call:` are classified as tool results or calls even when the native record uses an assistant role.
Search resolves these envelopes before ranking and returns the effective role; existing indexes don't need rebuilding.
Mentions of these markers inside ordinary prose don't change its role.

Whitespace-separated query terms are literal keywords combined with AND; FTS operators are not evaluated.
Punctuation within a term separates adjacent tokens, so `daemon/lib/shuttle/harness_paths.ex` matches that sequence of path fragments rather than scattered words.
Underscores stay inside tokens, preserving exact identifiers such as `handed_off_at`; searching `handed` alone does not match that identifier.
Repeat `--session <uuid>` to select several sessions, or use `--fiber`, `--since 30d|YYYY-MM-DD`, `--project <path-prefix>`, and `--harness claude|codex|pi|antigravity` to narrow the results.
Search excludes the calling harness session by default (see `shuttle send-file` for how it is found).
Outside a harness there is no automatic exclusion; board searches have no caller.
`--include-self` disables only automatic exclusion, including when `--session` selects the caller explicitly.
Repeat `--exclude-session <uuid>` to exclude additional sessions; these exclusions still apply with `--include-self` and intersect all other filters.
Results contain one row per session by default, ranked by that session's best-scoring message, with `matches` counting all matching messages after filters.
`-n, --limit` defaults to 20 sessions.
`--per-message` returns individual message rows instead; the limit counts messages and each row's `matches` is 1.
A fiber filter resolves through the session ledger and never broadens on ledger failure.
Ledger enrichment adds linked fibers to hits; an unavailable ledger is reported in `errors` without discarding otherwise valid search results.
`--json` returns `{query,index,hits,errors}` with non-null arrays; each hit includes its source location, timestamp, role, higher-is-better score, marked snippet, matching-message count (`matches`), and fiber links.
Human output shows the project basename and an `open: <path>:<line>` hint for the native transcript.
Matches are bold on a terminal and wrapped in `«»` in JSON or non-terminal output.

SessionEnd hooks record session lifecycle events without launching transcript index processes.

## Shuttle hooks

These event and commit adapters are also installed by the felt plugin, but the
`shuttle` binary owns their ledgers and mailbox behavior.

| Command | Purpose |
|---|---|
| `shuttle hook event` | Append one harness event to the host-local activity stream (`~/.shuttle/events.jsonl`) and handle Shuttle mailbox registration/delivery |
| `shuttle hook antigravity` | Translate one Antigravity CLI (agy) hook payload into the event `shuttle hook event` records, register its conversation for messages, and print queued context as agy's `injectSteps` on SessionStart and PreInvocation (nothing on tool events); the felt plugin for agy installs it |
| `shuttle hook commit` | Record a commit from a Bash call in the host-local commit ledger (`~/.shuttle/commits.jsonl`) |
| `shuttle hook handoff` | Offer the session's one-shot context-budget handoff reminder (see [Agents & Plugin](../agents.md)) |
| `shuttle hook interrupted` | Record a human interrupt read from a harness transcript on the activity stream (`--session`, `--harness` a harness whose transcript records interrupts: `claude\|codex`, `--at` ms, `--id`, `--cwd`); the daemon calls it, no harness hook does |

The hidden `shuttle context-mailbox` subcommands (`put`, `get`, `receiver`, `revoke`) are daemon-internal, not a user surface: `put` is how the owner enqueues every fiber message `/deliver` receives into the fiber's inbox, and shares its code with `shuttle inbox put`; `get`, `receiver` and `revoke` read and change which conversation is the fiber's receiver.

## `shuttle` (dispatch layer)

The `shuttle:` block is opaque frontmatter to felt: `felt show -j` and `felt
ls -j` return it without a resolved facet, and felt never validates its schema.
`shuttle show` and `shuttle ls` read the local archive and resolve local configuration metadata.
They are also daemon library reads; they do not report owner-observed lifecycle or worker liveness.
Use `shuttle status` and `shuttle threads` for operational state from the owning hosts.

`shuttle` owns that schema and the resolved view. Its local write verbs work
offline and validate before they touch disk. When a fiber's
`shuttle.host` names a remote in the resolved fleet (an enabled entry in
`~/.config/shuttle/remotes.json`, or a tailnet peer the local daemon
discovered),
`pause`, `resume`, `close`, `reopen`, `set-agent`, `set-model`,
`set-outcome`, `reshape`, and `uninstall` route through the local daemon to the
owner; `dispatch` does the same. `snapshot`, `dispatch`, `status --all`/`--remote`,
`sessions`, `transcript`, `message`, and
`validate-identity` talk to the local daemon (127.0.0.1:4000 or a unix socket,
per `shuttle host`). `resume` on a fiber this host owns goes
through its daemon when it answers, which applies it with `--local` inside
its Poller, serialized with the Poller's state changes (a poll read in flight
sees the old document or the new one, written in one atomic step); a daemon
that cannot be reached means the document is written directly. A daemon that
takes the request but does not answer within 5 s is reported ("did not answer
in time … may still apply"), never bypassed with a local write, since the
transition may still land there. `--local` writes the document here and never
routes; on a fiber another host owns it is refused. If routing to an owner is
impossible, the CLI explains why and names the command to run there. For what
the daemon speaks directly, see the [HTTP API](api.md).

Owner routing uses the local document's `shuttle.host`, not the local daemon's snapshot.
The owner need not have polled the fiber yet.
The daemon refuses an explicit origin outside its own fleet with 400 naming that origin; it never substitutes a local Git mirror or local file for an unknown destination.
A missing lifecycle, dispatch or single-fiber read returns 404 naming the fiber and owning host.
The daemon never runs Git or `felt sync`.
Armed remote creation transfers the document directly through `/fiber/create`; lifecycle changes use the owner's existing routes.
A remote `resume` or `dispatch` carries this host's copy of the fiber: an owner whose copy already holds the constitution (a `shuttle:` block naming the owner) keeps it and prints how the copies differ, `--carry` sends this host's version anyway, and an owner whose copy has no block, or a block for another host, takes this host's version first.

### Install / reshape the contract

| Command | Purpose |
|---|---|
| `shuttle install <fiber>` | Install as a one-shot dispatch role (`--project-dir` required unless `--disabled`, `-m` agent, `--host`, `--disabled`) |
| `shuttle repeat <fiber>` | Install as a standing (cron-scheduled) role (`-s/--schedule` and `--project-dir` required, `-z/--tz`, `-m`, `--host`) |
| `shuttle thread <parent> "<ask>"` | Create a child constitution under `<parent>`, armed unless `--disabled`, and print its id. The ask becomes its name and lede. Host, project_dir, role and agent inherit from the parent, except that a lead-only parent agent (`lead_only` in the registry, e.g. `claude-fable`) hands its threads to its `thread_agent` or the default agent; override with `--host`, `--project-dir`, `--role` (a bare office takes the checkout's `felt.person`), `--agent`; a child given no role is stamped with that person. Changing `--host` requires `--project-dir`. Armed remote creation goes through the owning daemon, which validates paths and writes the fiber in its own store. An unreachable owner fails creation without writing a local copy. `--disabled` keeps a local draft. `--slug` names the child (default: derived from the ask). Runtime, schedule, seat and `surface` do not inherit. `--take` moves the caller's live session into the child and arms its source for a fresh worker; it requires the caller's host and is incompatible with `--disabled`. If migration fails, the child stays created but disabled |
| `shuttle threads <fiber>` | A constitution's direct threads from this host's daemon, using owner-authoritative feeds; unavailable owners permit a labeled stale local copy in every state. A reachable owner's incomplete cache reads Unknown with its cache state, without an unreachable-host claim. Grouped Waiting, Working, Armed, To review, Draft, Resting. Armed is active with no worker running anywhere the daemon can see; `Armed · host unreachable` means its host is out of the daemon's fleet view. Each row gives the id, state, name, the first sentence of the outcome, and the count of unfinished threads below; a thread resting until something reads `⏸ until <name>`; `N waiting for its next worker` counts the thread results and messages queued for a constitution this host owns that has no live worker, on the header for the orchestrator itself and on each row. Archived threads (a tempered or discarded verdict) are a count; `--all` lists them and every deeper level, indented. `--json` adds each thread's board column and `pending_results` |
| `shuttle reshape <fiber> [kind]` | Change an existing block's `kind` and/or a standing constitution's schedule (`-s/--schedule`, `-z/--tz`) |
| `shuttle uninstall <fiber>` | Remove the `shuttle:` block; the fiber, its status, and its tags are untouched, and a live worker keeps running |

`install` and `repeat` are create-only: each refuses a fiber that
already carries a `shuttle:` block, pointing at `reshape` (kind/schedule),
`set-model`/`set-agent` (agent), or `uninstall` (start over). A fresh create
settles status (`install`/`repeat` arm to `active`, `install --disabled`
parks at `open`); an arming create refuses a closed fiber — arming
something already reviewed needs an explicit `reopen`. `reshape` touches only the block's shape — `kind`, and a standing
constitution's schedule — and leaves status and verdict fields exactly as found, so a
paused or closed constitution can be reshaped in place without being re-armed; `kind`
is optional, so `reshape <fiber> --schedule "0 7 * * *"` is a schedule-only
edit. Lifecycle moves (`pause`/`resume`/`close`/`reopen`) are
untouched by any of this.

### Lifecycle

| Command | Purpose |
|---|---|
| `shuttle adopt <fiber-id> [title]` | Atomically create (unless `--existing` or present), install as a draft, claim for the current terminal conversation, and activate a fiber (`--project-dir`, `--host`, `--agent`, `--session-uuid`, `--rex-session`, `--rex-block`, `--tmux-session`, `--tmux-pane`, `--existing`, `--role`, `--json`). Leaves the fiber as an open draft if claim fails |
| `shuttle claim <fiber>` | Associate the current terminal conversation with an installed draft without launching or activating a worker (`--session <native-id>`, `--tmux-session <name>`, `--json`) |
| `shuttle migrate <to-fiber>` | Move the caller's live conversation to another installed fiber on the same host without ending it. Infer the source from current session/pane identity; `--from <fiber>` overrides it. The destination must have no live worker. The source gets a fresh worker from `## Status`; `--rest` leaves it resting, or `--disabled` leaves it open in Drafts. The destination receives the session UUID, watcher and current assignment; exact-session messages still reach it. Repeating the same session/destination succeeds without a second move. No conversation context is copied or merged. Supports `--json` |
| `shuttle pause <fiber>` | Set status to `open`, kill any live worker (`--no-kill` to leave it running) |
| `shuttle resume <fiber>` | Set status to `active`; a standing constitution resumes its schedule with its run concluded (`handed_off_at`), so it runs at the schedule's next tick; a closed fiber is refused (use `reopen`). Arming requires a `project_dir`: `--project-dir <dir>` sets it on a block without one; remote paths are validated and saved by the owner, without changing the local Git mirror. A remote resume carries this host's copy (`--carry` insists on it over a copy the owner holds); an owner without the fiber has it created from this host's armed copy, moving a local draft and keeping any other copy here. `--local` skips the daemon |
| `shuttle rest <fiber>` | Put a constitution in Resting without review: `status: open` + `horizon: stashed`, verdict cleared, run concluded, an arrived `due:` cleared, a live worker stopped. Works in any state, including standing and tempered/discarded. `--until` says what the rest lasts until: a `YYYY-MM-DD` return day, or a fiber or free text it waits for (`shuttle.blocked_on`, a fiber stored by uid, whose close reaches the thread's orchestrator as context and arms nothing); `--until ''` rests undated and waiting for nothing. On a constitution already at rest, `--until` changes only that; `resume` and `close` clear the wait. Routes through the owning daemon, which writes it inside its Poller and stops the worker through its terminal backend; `--local` writes here and stops nothing, and an unreachable daemon is bypassed with a local write and tmux kill |
| `shuttle reopen <fiber>` | Reopen a closed/reviewed fiber for active work (`--as-draft` for `open` instead). From another host, a default reopen starts a fresh worker on the owner; `--message <text>` or `--message-file <path>` adds its launch directive on that remote route. Arming requires a `project_dir`: `--project-dir <dir>` sets it on a block without one |
| `shuttle close <fiber>` | Set status to `closed`; `--tempered=true\|false` records a verdict. Without the flag a oneshot's verdict is cleared. A standing constitution has no review: `close` refuses it without a verdict; `--tempered=true` tempers its current run (clears the ask, concludes the run, keeps the schedule armed) and `--tempered=false` retires it and ends its schedule; `rest` pauses it. A thread wakes only its nearest orchestrator by default; `--quiet` sends its outcome as context without waking. The next ordinary close wakes again; ask always wakes. Results never automatically propagate further. A worker closing its own top-level oneshot for review must have written `tapestry.html` since its dispatch. Without a verdict, top-level work awaits the human's review and a thread its orchestrator's. `--review "<why>"` marks a thread for the human: it closes the thread, writes `shuttle.review: {note, at}`, and puts it before the human for review; the note is required, `--tempered` is exclusive with it, a worker cannot mark its own fiber, and reopening clears it. A worker closing its own constitution for review is refused while a closed, unmarked thread beneath it has no verdict. `--post "<conclusion>"` is the closing post: it is written as the fiber's `outcome` and as the text of the board's close line, with each `--file` attached; without it the outcome stands as it is. `--post` is refused with `--review` and on a standing run's temper. The close line is addressed to the orchestrator that reviews it, or to the human at the top level; a mark is addressed to the human with its note; a verdict is unaddressed |
| `shuttle set-agent <fiber> [agent]` | Save next-launch agent and axes (`--effort`, `--chrome`, `--project-dir`); leaves the current session running. The agent is a registry id or alias: any other name, a model name included, is refused with `<id> is not an agent; \`shuttle agents\` lists them`, as `set-model`, `install -m`, `repeat -m` and `thread --agent` refuse it |
| `shuttle set-model <fiber> <agent>` | Change only the dispatch agent, preserving runtime keys |
| `shuttle roles [--json]` | `felt roles` under Shuttle: list role charters ([where a charter lives](../concepts/roles.md#where-a-charter-lives)), with `slug`, `id` (the charter's fiber id in the shared store), `name`, and `outcome`; JSON is an array (empty as `[]`) |
| `shuttle role <fiber> <office>[/<person>] [--new "Office name"]` | Set the fiber's top-level `role` and remove any `shuttle.role` from its block; a bare office is stored as `<office>/<person>` when the repository's `git config felt.person` names one. The office needs a charter; `--new` creates a missing one, and `--clear` clears both role and seat. Preserves lifecycle and execution settings |
| `shuttle seat <fiber>` | Set `shuttle.seat: true`; requires a role. `--clear` removes the seat field. Preserves lifecycle and execution settings |
| `shuttle channel <fiber> <name>` | Set `shuttle.channel` to `<name>`, trimmed and otherwise as given (one line, not empty): constitutions declaring one name speak in one board channel, and a thread inherits its ancestor's. `--clear` removes the key. Works on a constitution of any status, closed included, and preserves lifecycle, outcome, execution settings and runtime. A remote-owned constitution is changed through its owner daemon |

Older CLIs can duplicate UID-less documents and delete the sender's copy when resuming across store views; cross-host documents need an intrinsic `id:` UID.

`roles` and `role` find charters by [the charter rule](../concepts/roles.md#where-a-charter-lives): `roles/<slug>` at the top of the shared store (the enclosing store when the project is a view into it), or `<mount>/roles/<slug>` in a repository linked in at its top level, the store's own winning a collision.
`role --new` creates a missing charter in the shared store's own `roles/`.
Nested charter notes are excluded from the list.
`role --new` validates the slug before creating anything and leaves existing charters untouched.
A new charter starts with a short lede naming the constitution it serves and asking its holders to grow the charter.
Without `--new`, assigning a role still requires an existing charter.
| `shuttle ask <fiber> "<one-line question>"` | Raise a non-blocking question for the human in `shuttle.ask: {text, at}`; the worker keeps working, and the board draws the constitution waiting on you with the question as what it wants. `--clear` removes it. Resume, reopen, and messaging the fiber's worker clear it too. Works offline and accepts `-C <store>`. The same report rule as `close` holds for a question from a worker on its own top-level oneshot |
| `shuttle set-outcome <fiber>` | Set the `outcome:` field (`--outcome`, or stdin for multi-line) |
| `shuttle handoff <fiber>` | Stamp the clean-exit signal; a worker's final action before its tmux session ends. A block naming an agent the registry does not know is refused before stamping, so the successor never launches on it: fix it with `shuttle set-agent` and hand off again |

To adopt your current conversation, install the constitution with
`shuttle install <fiber> --disabled --project-dir <dir> -m <agent>`, then run
`shuttle claim <fiber>` and, only after it succeeds, `shuttle resume <fiber>`.

`shuttle handoff`, `shuttle close`, and `shuttle rest` accept an omitted fiber inside a worker.
Current native session bindings and the exact tmux pane identify its destination after `migrate`, ahead of an inherited dispatch path.
If the only available identity is `SHUTTLE_FIBER_PATH` (no native session ID or tmux pane), the environment cannot follow the move: pass the destination explicitly to `handoff`, `close`, and `rest`.
Terminal claims identify the current tmux pane or Rex session and block; `--tmux-session` supplies an
explicit existing session. App claims use `CODEX_THREAD_ID` or `--session`
and require the daemon to verify the native conversation. The claimed host
and surface must match the installed task. If verification fails, leave the
constitution open; activating it could launch another worker. A claim made
from inside a harness (its session read from the environment) also names the
harness process, so the worker ends when that process does, and the terminal
is then given back to the human rather than closed.

### Read / inspect

| Command | Purpose |
|---|---|
| `shuttle ls [query]` | Felt-compatible fiber listing/search with Shuttle's resolved facet in JSON output |
| `shuttle show <id>` | Felt-compatible fiber read with Shuttle's resolved facet in JSON output |
| `shuttle check` | Validate every `shuttle:` block in the selected store and report host drift |
| `shuttle change <fiber> [--pr N \| --base B \| --list]` | Write a Git snapshot and optional reading story as a `.change.json` companion, or into the host cache with `--cache`; with neither `--pr` nor `--base`, the fiber's `shuttle.change` names the change; `--list` reads the PRs it follows from GitHub without baking (`--head`, `--repo`, `--story`, `--name`, `--check`, `--cache`, `--json`) |
| `shuttle status [fiber]` | One line per shuttle-managed fiber, with remote state read from its owner; unavailable owners permit a labeled stale local copy, while authoritative not-found never does. `--all`/`--remote` include the complete owner inventory, including closed and rested constitutions absent from the local archive. Closed ones hidden from the table (`--closed` shows them; `--json` always includes them; `--all`, `--remote <name>` — mutually exclusive, `--include-orphans`); with a fiber, a detailed single-fiber report ending in a dispatch verdict: eligible on which host (status and host ownership, noting a missing `project_dir`), or the verb that makes it so. Its `--json` adds the board's `column` (`drafts`, `in_flight`, `awaiting_review`, `tempered`, `discarded`, `resting`, `roles`) and the review `verdict` (`tempered`, `discarded` or null), and for a rest that waits, `blocked_on` and the `until` name it reads as. A block naming an agent the registry does not know is flagged, `!` in the table with a line naming the fix, and `agent_problem` in `--json`; the daemon maps no other name to an agent, so such a block fails every dispatch until fixed |
| `shuttle ps` | Live terminal worker sessions |
| `shuttle snapshot` | Print the local daemon's state snapshot |
| `shuttle dispatch <fiber>` | Ask the daemon to dispatch a fiber now (`--ad-hoc`); remote owners route through this host's daemon, carrying this host's copy (`--carry` insists on it over a copy the owner holds), and an owner without the fiber has it created from that copy first. `--message <text>` or `--message-file <path>` adds a launch directive |
| `shuttle tapestry <fiber>` | Report a fiber's `tapestry.html`: whether it exists, its path here, the URL that serves it, and the thread page (`--path`, `--url`, `--open`, `--json`) |
| `shuttle sent-files ls <fiber>` | List the files a fiber's workers sent, newest first, with caption and URL (`--json`) |
| `shuttle sessions [fiber\|session-uuid]` | With no argument, list live native sessions across the fleet (`--host`, `--harness`, `--json`); JSON rows include `fiber` when the host's session ledger records a pairing. With `--since <time>` (what `shuttle find --since` takes: `30d`, `12h`, a date, or an RFC3339 time), list every Claude, Codex, Pi and Antigravity session on this host — or on `--host <host>`, through that host's daemon — with a transcript message since then, live or ended, newest first: last activity, `live`, harness, the `shuttle show` address on that host, and the fibers it worked on (`--harness`, `--json`). With a fiber or session, show the composite ledger by UID, including historical paths, lifecycle events, hosts, harnesses, staleness, transcript availability, and a canonical `address` when the row can be addressed. A session UUID or `--commit <sha>` reverse-resolves the owning fiber and its disposition; `--materialize [--dir <d>]` resolves every available transcript to an ordinary local file and writes a `manifest.json` |
| `shuttle message <target> [text\|-]` | Send to a full address, a unique native session ID, or a fiber path, slug, or UID, which sends through its owner's durable inbox (`--attach`, `--file`, `--context-only`, `--notify-when-idle`, `--notify-wake`, `--from`, `--message-id`, `--json`). Session IDs resolve through live discovery and the session ledger; ambiguous IDs list their candidate addresses. `-` and `--file -` read multiline text; repeat `--attach <path>` to include binary files. Receipts print the resolved canonical address and message ID for a safe explicit retry. A fiber message is refused, sending nothing, when the local daemon reports a CLI contract level other than this shuttle's, or when the fiber's owner reports that its own CLIs are at another level than it was built for: such a daemon queues the message and does not deliver it until it runs level with its CLIs |
| `shuttle transcript [--date YYYY-MM-DD] [--fiber <id\|slug>] [--since HH:MM[:SS]] [--recorder HOST]` | Read the day's spoken transcript, including the card each line went to (`--json` for the daemon response) |
| `shuttle say "<text>"` | Queue a spoken line on the speaker host, in the voice of the calling worker's role (its charter's `voice:`); playback waits behind queued lines and while the human talks, and a line whose card is out of view is held until its card is in view or `shuttle say --play` opens it. `--fiber` names the speaker from a plain terminal; `--voice` overrides the voice for this line. For voice conversations with the human only |
| `shuttle voices` | List the voice bank and pocket-tts built-ins on the speaker host, each with the role whose charter claims it |
| `shuttle say --held` | List spoken lines held because their card is out of view; `shuttle say --play` opens the card waiting longest (routes Listen to it and plays its lines), `--next` moves to the next card, `--stop` leaves the rest held |
| `shuttle inbox consume <fiber-key> <address-or-dash> <epoch> [--idle] [--unknown] [--busy] [--costly] [--message <id>]` | Consume a fiber's inbox for its live worker, or with `-` and epoch 0 for a fiber with no worker; JSON action is `wait`, `wake`, `context` (quiet entries sent to a receiver without a hook), `fresh` or `launch` (a session to start for the reserved `members`), with `turn` when the worker's idle and cost facts would decide, and `message`, the `--message` entry's state after the pass |
| `shuttle inbox record-begin [--from <sender>] [--source human\|voice\|pulse\|message] [--fiber <uid> [--ask <question>]] <fiber-key> <id>` | Record a line the daemon transports itself (typed or spoken human input, a pulse tick, an agent's fresh request), read from stdin, and with `--fiber` a human line's family-board row; JSON `created` permits only the first caller to transport it, and `disposition` is the record's outcome |
| `shuttle inbox record-settle <fiber-key> <id> delivered\|unknown\|undeliverable` | Settle a recorded line without resending it |
| `shuttle inbox put <address> <message-id> <text>` | Enqueue an entry in this host's inbox for a fiber key or a session's `shuttle://` address, with its delivery wishes (`--source`, `--turn`, `--if-costly`, `--not-before`), `--from` and `--derived`; see [The inbox](../dev/inbox.md) |
| `shuttle inbox pending <address>... [--waking]` | Print one JSON object of each address's `{count, scheduled}`: the due entries' count and every entry with a delivery time, overdue ones included; `--waking` prints a count per address instead, of only the due entries that ask for a turn, free or held by an open batch, and none while a launch reserved in its lease still owes one |
| `shuttle inbox rekey <store>...` | Move every Shuttle-managed fiber's inbox still keyed `<store>:<uid>`, for any of the stores, to `fiber:<uid>`, and repoint session links; idempotent, run by the daemon at boot; prints how many moved |
| `shuttle inbox ls <fiber-or-key> [--scheduled]` | List pending entries with id, time, sender and first text line (`--json`); `--scheduled` includes only entries with a delay, including overdue entries and their wait reason. Fiber ids, slugs and uids use the owner's inbox, and one that names no fiber is an error; raw keys read this host |
| `shuttle inbox cancel <fiber-or-key> <message-id>` | Cancel a pending entry, so it is never delivered; an in-flight transport attempt cannot be retracted. Fiber references route to the owner; an unreachable owner fails with its host named |
| `shuttle message [<fiber>] <text> --in <duration>\|--at <time>` | Schedule a durable fiber check-in; omitting the fiber uses the sender's own fiber. Durations accept Go units and `d`; times accept RFC 3339, sender-local `YYYY-MM-DD HH:MM`, or next local `HH:MM`. `--fresh` and session addresses are refused. The receipt prints the resolved sender-local and UTC time; retry with `--message-id <id> --at <that UTC instant>` |
| `shuttle inbox thread-state` | Establish the thread capture window and print its baseline (exit 3 on a corrupt state) |
| `shuttle inbox thread-put` | Capture a JSON array of `{id, record, board}` thread publications from stdin into the routing inbox, storing each `board` record in its entry, then append every board line the routing inbox's entries still owe; print the ids created, the publications refused and the board lines that could not be appended |
| `shuttle inbox routes` | List the routing inbox's pending thread publications |
| `shuttle inbox route <id> --current true\|false\|unknown` | Advance one routing entry from the daemon's fresh facts (`--record` once its recipient resolves, and `--key` when this host owns it): wait, place, settle as superseded or expired, or answer `forward` or `session` for the daemon's handoff |
| `shuttle inbox settle <id> forwarded\|delivered\|undeliverable` | Record a routing entry's confirmed handoff |
| `shuttle meeting start` | Start a meeting: Listen on, unmuted, pinned to the calling worker's card (`--fiber` names one from a terminal), transcribing the computer's audio as well as the mic. The meeting also ends when Listen stops, when Listen follows again, or after twenty minutes with nothing heard |
| `shuttle meeting end` | End the meeting: stop transcribing the computer's audio and follow the view again; a no-op outside a meeting |
| `shuttle transcript <session-id>` | Print the native transcript path when local, or verify and materialize an exact remote copy in the managed cache; inspect it with the harness's ordinary `jq`/`rg` recipes (`--json` for metadata and paths) |
| `shuttle agents` | List the effective agent registry (`--source builtin\|user`) |
| `shuttle agents resolve <agent>` | Resolve one agent with its axes (`--effort`, `--chrome`) |
| `shuttle agents init` | Seed `~/.config/shuttle/agents.json` from the built-ins (`--path`, `--force`) |
| `shuttle agents effort <agent> <level>` | Set an agent's default effort as an `overrides` entry in the user registry (`--reset` removes it) |
| `shuttle attach <fiber>` | Attach to tmux or ask the local daemon to open a Rex worker in the Rex app; recreate a missing terminal Codex viewer of the same owned thread without starting a turn. Remote Rex has no SSH TTY renderer |
| `shuttle session-name <fiber>` | Print the canonical worker name for a fiber |

`attach`, `session-name`, `tapestry`, `sent-files ls`, and fiber message
targets require one exact match across configured stores; they refuse guessed paths and duplicate matches.

### `shuttle change <fiber> [--pr N | --base B | --list]`

Bake a change on the host holding the fiber and worktree:

```bash
shuttle change review-task --base origin/main --story story.json
shuttle change review-task --base origin/main --head topic/change \
  --repo "$PWD" --name walkthrough --story story.json --check --json
```

| Option | Meaning |
|---|---|
| `--pr N` | GitHub PR number; bakes the PR's head against its base |
| `--base B` | Commit or ref; compare its merge base with head to head. Without `--pr` or `--base`, the fiber's `shuttle.change` names the change: its first PR, else the checked-out branch as it stands, uncommitted work included, against `change.base` or the remote's default branch |
| `--head H` | Head commit or ref, default `HEAD` |
| `--repo DIR` | Git worktree directory, default fiber's `shuttle.project_dir` joined with `shuttle.change.repo`, else cwd |
| `--story FILE` | Optional JSON reading story with chapters, stops, flags and role overrides |
| `--name NAME` | Companion filename stem, default slugified head ref, else fiber slug for detached `HEAD` |
| `--check` | Validate and report without writing |
| `--cache` | Write the bundle to `$XDG_CACHE_HOME/felt/changes/<fiber-uid>/<name>.change.json` (`~/.cache` when unset); read a story sidecar beside the fiber but write nothing there, and emit no file receipt |
| `--list` | Read each PR in `shuttle.change.prs` through `gh pr view`, concurrently, and print it in the order named: number, title, head → base, state, checks and line counts, or gh's complaint for a PR it cannot read. Fetches no refs and writes nothing; `--json` prints the list (`[]` for none). Combines with none of `--pr`, `--base`, `--head`, `--story`, `--cache`, `--check` |
| `--json`, `-j` | Output the validation and hunk-coverage report as JSON |

The command resolves the supplied refs, finds their merge base and writes `<name>.change.json` atomically beside the fiber's Markdown file.
The patch, files, hunks, coverage and commits all describe the change from that common ancestor to head, like a pull request's three-dot diff.
The bundle's `base` records the merge-base SHA; `base_ref` preserves the supplied base ref.
No common ancestor is an error.
Only committed content enters a `--base` or `--pr` snapshot; dirty and untracked files are excluded. The fiber-named branch view adds them as one `Uncommitted changes` commit, staged through a copy of the index (see [Changes](../concepts/changes.md#the-change-on-open)).
`repo.name` comes from origin's repository path, falling back to the main worktree directory's basename.
`repo.forge_url` normalizes HTTP(S) origins and scp-style GitHub/GitLab origins to HTTPS without credentials, query, fragment or `.git`; other origins produce `null`.
The version 2 bundle contains commits and a file inventory with path-derived roles, one source-row table per file, and hunk/window references for Story and Remaining.
Other bundle versions need a rebake.
Go resolves each story stop's excerpt; the reader does not parse Git output or calculate coverage.
Without a story, `story` is `null` and every changed line remains unshown.
A successful bake beside the fiber emits a fiber-addressed file receipt, so the change appears among the fiber's sent files without an embed.
The title comes from the story's optional `title`, otherwise the head commit subject.
A fiber doesn't need a Shuttle block; a block naming another host requires running the command there.
The CLI invokes Git directly and makes no model calls.

Story input rejects unknown JSON fields and duplicate chapter ids.
Validation reports every unknown file and every range that overlaps no hunk on the chosen side.
Invalid stories exit nonzero and don't replace an existing bundle.
Changed lines are shown by the union of stop ranges on their own side; context-only stops and flags do not count.
Go resolves the unshown changed lines into Remaining excerpts with a little context.
Text output lists changed lines shown of total and each remaining excerpt as `Remaining: path:line`.
Unshown lines do not fail validation.
`--json` emits `{valid, covered, total, uncovered, errors}`, with `path` added after a successful write.
`covered` and `total` count changed lines. Uncovered excerpts include `file`, `old_from`, `old_lines`, `new_from`, `new_lines` and `windows`; each window references the bundle file's source-row table.
`--check` emits the same report without writing or adding `path`.
See [Changes](../concepts/changes.md) for the full bundle schema and story-authoring format.

### Daemon and host operations

| Command | Purpose |
|---|---|
| `shuttle doctor` | Diagnose the shuttle binary, host identity/configuration, listener, daemon contract, and tmux integration; warn about local fiber context pending for at least ten minutes and about each fiber in this host's stores that cannot be read |
| `shuttle daemon start` | Start the local Mix release in the foreground; atomically claims its endpoint and refuses an answering daemon or live start, install or upgrade claim |
| `shuttle daemon stop [--within <directory>]` | Stop the local daemon using its reported boot path and mark the shutdown intentional; `--within` refuses a missing or out-of-directory release receipt |
| `shuttle daemon status` | Print daemon state including its booted `release_path`; exits 2 when the daemon is down |
| `shuttle daemon check` | Compare this host's daemon with these CLIs: a running daemon by the CLI contract level it was built for and its release version (by its contract level alone when a checkout built it), a stopped one by the version of the release it would start (not at all when a checkout built it). Prints both and the command that brings it level when they differ, nothing when they match or no daemon is installed; always exits 0 |
| `shuttle daemon upgrade` | Replace the selected fetched release with this CLI's version of the release archive, verified by starting its runtime before anything is replaced, and copy its `shuttle-launch` to `~/.local/bin` as the installer does; then stop a running daemon so its supervisor or respawn loop starts the new release. A daemon that is listening but does not report its version, or a `~/.shuttle/owner-node` naming another login node, fails the upgrade before anything is replaced. With no daemon running, the upgrade holds the daemon's ownership claim while it replaces the release, failing first when a daemon is starting, so a `shuttle daemon start` meanwhile fails and its retry starts the new release. When nothing restarts the stopped daemon, the upgrade fails naming `shuttle daemon start`, which runs in the foreground, and then `shuttle daemon release`. The replaced release is kept at `<release>.previous` unless the upgrade sees a daemon running the new one. A download has an overall time limit. The restart arms the boot quarantine. Refuses a release built from a checkout, which `bin/shuttle-deploy` deploys |
| `shuttle daemon select-release <path>` | Validate a built release and atomically select it in `~/.shuttle/repo` for the next launch; does not cycle a running daemon |
| `shuttle daemon release` | Release the boot quarantine |
| `shuttle daemon reset <remote>` | Restart recovery for a tripped, degraded or unreachable remote |
| `shuttle daemon install [options]` | Install the per-user keep-alive supervisor; `--stores` pins its store list |
| `shuttle daemon uninstall [--label <name>]` | Remove the per-user keep-alive supervisor |
| `shuttle version` | Print the running daemon version or, when it is down, the local Mix release version |

`shuttle` reads ordinary fiber data through felt's Go library. The daemon
shells out to `felt` for fiber content and writes and to `shuttle` for resolved
views and Shuttle-owned operations.

### Session discovery and messaging

No-argument `sessions` may report a Claude, Codex, Pi or Antigravity receiver with `state: "hook"`. This
means a supported hook registered the session for queued context; it does not
claim that a model turn is live. `last_seen` records the latest registration in
Unix milliseconds. A registration names the receiver's harness process and is
listed only while that process runs; a context-only message to a receiver
whose process has exited is rejected rather than queued. Peer JSON
rows include the fiber path when the session ledger records its pairing, and
provenance rows include a canonical `address` when the host and harness are known.
A message wakes its receiver by default; a busy Claude session's native inbox queues it behind the running turn:

```bash
shuttle sessions --json
shuttle message <address> "Please review the results" --attach results.csv
shuttle message <address> "Background for your next task" --context-only
```

`shuttle message` accepts that address, a unique native session ID, or a
Shuttle fiber path, slug, or UID.
Fiber targets require one exact match across configured stores; they refuse guesses and duplicate matches, and a slug naming several fibers is refused with their full paths.
Fiber sends use the owner's durable inbox whether a worker is live or dormant; attachments become retained owner-local file references.
The receipt says what became of this message: woken, followed up in a turn, delivered (as context, or before a retry), held as context for cost, starting or queued.
A fiber message held for cost and still unread after an hour is escalated: a fresh session on the fiber when the launch gate allows (as for `--fresh`), else the existing worker is woken.
`--notify-when-idle` subscribes when a hook or wake delivers the entry; with no text, the owner subscribes the fiber's live worker at once, and a fiber with no live worker refuses it.
A fiber absent from local stores can resolve by exact path or UID through the owner's live feed, without waiting for Git sync.
A session ID resolves through live discovery and the session ledger; a managed Codex ledger row keeps its transcript id in `session` and its address id in `thread_id`.
Ambiguous session IDs fail with
their candidate addresses. Addresses
use `claude`, `codex`, and `pi`; the ledger spelling `claude-code` normalizes
to `claude`.

For a fiber send, the [inbox consumer](../dev/inbox.md#the-live-fiber-consumer) decides delivery under its lock: a busy Codex worker gets terminal follow-up, Pi gets steering, and Claude gets it from its hook, or a native wake after 30 seconds or once its turn ends.
The following details describe session-addressed Claude sends.
A plain session-addressed `shuttle message` to Claude goes to the session's native socket in any turn state; during a turn, Claude's native inbox queues it behind the running turn, which takes it in at its next model call or, if none comes, runs it as the next turn.
The sender's receipt says what the native socket answered: `accepted` once a correlated reply appears, `queued` or `submitted` when none appears within 17 seconds, and `unknown` when it saw neither.
A refusal, a message Claude's receiver approval policy holds (which starts no turn), or an endpoint that is gone answers the sender in that receipt, and Shuttle sends nothing later.
Retrying the same message ID returns the original receipt without another write, unless the first send was refused before anything was written.
`--context-only` queues the message in the session's inbox for its hook.
Claude offers that mail only on `UserPromptSubmit` and `PostToolUse`; `PreToolUse` context can be lost when a tool is interrupted.
The main-thread hook records an offer by writing the message as context and acknowledging its mailbox entry.
Stop never drains or continues a turn.
Subagent hooks neither receive their parent's mail nor change the parent's turn state.
Claude hook batches stay below 8 KiB, including message labels.
A direct context-only message or durable fiber entry larger than this batch budget reaches Claude as a reference to its retained full-message JSON, never a truncated preview or a native wake.
Hook output and acknowledgment, like native delivery and receipt persistence, aren't atomic across a process crash: a hook that dies between writing context and recording it leaves its entries to be offered again, marked “Possible repeat”.
An interrupt while a sibling PostToolUse hook is still running can also discard Shuttle's already-acknowledged context.
The stock sibling hook is short, but a slow third-party hook widens this window; acknowledgment isn't transcript confirmation.
`--wake` forces the native wake path, including during a turn.
An ordinary send (neither `--wake` nor `--context-only`) to a Claude session whose prompt cache is cold and whose context is at least 250k tokens is held as context: the receipt is `queued`, and its detail gives the context size, how long the cache has been cold, and the two ways to act now.
`--fresh` asks the fiber's owner for a fresh session with the text in its launch prompt, deduplicated by `--message-id`.
It replaces a live worker or starts a dormant one only while the constitution is armed and the owner's launch gates allow it; it never reopens a closed fiber or bypasses quarantine.
A refusal fails with its reason, and the same `--message-id` may be sent again once that changes; a repeated id never starts a second session.
The new session is told where the previous conversation is.
`--context-only` or `--wake=false` queues context without starting a turn, regardless of state.
Codex takes quiet context through its hook, never as terminal input.
Hooks offer queued context when the receiver next prompts or uses a tool; Pi offers it before the next agent turn.

`--notify-when-idle` subscribes the sending session to one notice when the
receiver next ends a turn with nothing queued or running, or exits. A receiver
that is idle already answers at once, giving the time its last turn ended.
Text is optional: with text, the message is delivered and then the subscription
is made; without it, the receipt is `subscribed`, and for a fiber it names the
live worker the owner subscribed. The notice arrives as context
from Shuttle and names the receiver in its text; `--notify-wake` has it start a turn instead.
The callback address comes from the detected harness session.
`--from` names another sender; callbacks still reach the calling session.
The owning host records the subscription under `$SHUTTLE_DATA_DIR/idle/` and a
detached `shuttle idle-watch` observes it. Claude receivers subscribe through
Claude Code's native inbox (`notify_when_idle` / `peer_idle_notice`), and a
turn whose Stop hook left background tasks running waits on to the next quiet
stop. Codex and Pi receivers are watched through the host's hook event stream:
a `stop` with no background tasks and no further activity within 2 s is idle,
and `session_end` is an exit. Hook events do not see input queued inside the
harness. After 12 hours, Claude Code's own subscription lifetime, the notice
says the subscription expired and makes no claim about the receiver. The
receipt's `idle` object gives `state` (`watching` or `unsupported`), the
`signal`, and a detail. Idle means the turn ended, not that the work is done.

Shuttle routes to the configured owner host and its live harness integration.
Claude uses its receiver-registered native inbox; Codex and Pi use their native
harness integration; Antigravity takes queued context from its hooks before each
model call and a wake typed into its terminal. Existing Confer Pi workers
also remain addressable, but standalone Pi sessions do not require Confer.
Hooks alone cannot wake Claude or Codex: install and enable the receiver's hooks
for context delivery, and use a supported live native endpoint for wake.
An explicitly forced wake never silently becomes a context-only send. Pending native input
or approval is handled by the harness, not by injecting terminal keystrokes.

Codex workers run through the terminal harness. Context-only messages wait in the session's hook mailbox for its next hook. A wake is pasted into the exact Codex terminal through the owning daemon's `POST /api/v1/sessions/input` and submitted. A paste the daemon refused before typing is `rejected`; one that failed after text may have reached the composer, or any other daemon fault, is `unknown` with `ambiguous_delivery`. A repeated send with the same message id returns that receipt without pasting again; a message delivered to a fiber whose outcome is still unknown five minutes later is sent once more to the fiber's current worker, marked "Possible repeat".

Receipts describe delivery evidence, not task completion. HTTP 200 carries a
processed delivery receipt, including `rejected` and `unknown`. HTTP 400 reports
`invalid_address`, `wrong_host`, `invalid_request`, `unsupported_harness`, or
`preflight_failed`; preflight refusals may include a rejection receipt. HTTP 409
reports `message_id_conflict` when a session-message ID is reused for changed content.
Conflicting fiber-mailbox content is rejected by `/deliver` with HTTP 422.
Other rejected receipts—including `unavailable`, `session_not_found`,
`wake_required`, and `wake_refused`—return 200. HTTP 5xx means the Shuttle CLI did not
provide a valid receipt or the owner could not be reached; the daemon may
include a synthetic `unknown` receipt. `shuttle message` exits 0 for
`accepted`, `submitted`, `queued`, `context_added` and `subscribed`, and for a fiber's
`woken`, `followed_up`, `delivered`, `held`, `starting` and `scheduled`; it exits 1
for `rejected`, `unknown`, or another command error.

A fiber target with no live worker (a seat at rest, an unarmed thread, a
closed constitution) is not rejected: its owning daemon queues the text in the
fiber's durable inbox, the same one thread results wait in.
For a wake send, the owner starts a session when the fiber is armed (`status:
active`), not at rest, not a standing constitution whose run is due, and the
owner holds no boot quarantine and has a free worker slot; the session takes
the text through its hook. A draft or a constitution at rest keeps the text
for whoever arms it. The receipt reads `starting a session on <fiber> for it`
(`status: starting` in `--json`), or `queued for <fiber>: <what it waits for>`
(`status: queued`, with `detail`).
A context-only send prints `queued as context for <fiber>` (`status: queued`), whether or not a worker is live: it waits for the worker's next hook.
Neither starting nor queued is delivered; a worker reads the text through the fiber's inbox.
A worker that starts meanwhile takes the entry like any other.
Retrying with the same `--message-id` queues it once. Attachments wait in the inbox as retained owner-local file references,
and a fiber with no `shuttle:` block is refused. A target that does not
resolve or is ambiguous fails with exit 1 and no receipt.
Session routing also requires a recorded worker or one exact live peer; a missing session address fails before the session-message request. Once resolved, it prints
`sending <id> to <resolved address>` to stderr before delivery; if interrupted,
retry with `--message-id <printed id>`.

Retry an uncertain delivery with the identical request and the same
`--message-id`, never a fresh ID. A retry answers the stored receipt unchanged
and never resends the message, unless the first send was refused before
anything was written; one that finds the first send still running, or
stopped before it recorded an outcome, answers `unknown` with
`ambiguous_delivery` at once.
Changed content, including a changed `reply_to` target, requires a new message ID.
Requests without `reply_to` retain the same deduplication fingerprint; adding a reply target to an existing request is changed content.

Claude preserves its native inbound hold/refuse policy. For a wake, `queued`
means Claude put the message behind its current turn; `submitted` means the
transcript shows native admission without a model reply; `accepted` requires a
correlated real assistant reply. If the observer sees no admission stage, the
receipt is `unknown`, even if Claude processes the message later. Context-only
messages use separately enabled Shuttle hooks. To disable those
hooks' message registration and delivery, set `SHUTTLE_MESSAGES=off` in the
receiver environment. Installing hook files does not establish that the harness
has enabled or trusted them; discovery reflects receiver registration.

Pi wake delivery is `queued` only when Pi's prompt API confirms steer or
follow-up queue admission. It becomes `accepted` when the session transcript
records the exact labeled user message. Without a session transcript, Pi
delivery is `unknown`.

| Receipt | Evidence |
|---|---|
| `queued` | Hook mailbox: context-only, no turn starts. Claude-native or Pi-native wake: the harness confirmed queue admission behind the current turn |
| `submitted` | Claude transcript shows the native user row or `queued_command`; admission only, with no model reply observed yet |
| `context_added` | A main-thread hook acknowledged adding context; no turn started |
| `accepted` | Pi has the exact correlated user-message row; Claude has a correlated real assistant reply; other transports report their native runtime acknowledgement |
| `unknown` | Delivery may have succeeded without enough evidence; retrying the same ID answers this receipt and sends nothing |
| `subscribed` | `--notify-when-idle` with no text: the subscription is recorded and watched; nothing was delivered |
| `rejected` | The request or receiving transport refused delivery |

No receipt proves that a model read, acted on, or integrated the message.
Hook offers can repeat, marked “Possible repeat”, if the receiver crashes after
writing context but before recording the offer; message IDs are stable. Repeating the identical send
with the same `--message-id` retrieves its recorded result without redelivery.
`--from` names the sender. Without it, the sender is the calling session: a live receiver registration in the process ancestry, then the session id the harness exports, then `external`.
A fiber worker also supplies `reply_to`, a separate fiber target.
The delivered header names the sender as `[from <fiber>]`, or `[from <address>]` for a session without a fiber.
A sender that is not a session keeps its label and adds the target: `[from shuttle; reply to <fiber>]`.
Reply with `shuttle message <fiber> ...` to reach the fiber's current worker across handoffs.
Nonworker messages omit `reply_to`.
If the receiver uses another routing alias for the sender's host, resolve an explicit session reply through its own `sessions` output.

An explicit session target never forwards to a successor.
A receiver's `SessionEnd` withdraws its hook and records that the session ended; a missing or unreachable native endpoint alone only establishes unavailability.
For a rejected or unknown explicit-session delivery, the receiving owner's CLI consults its session ledger.
When that ledger pairs the session with a fiber whose current worker differs, the receipt names the fiber and current worker and advises `shuttle message <fiber> ...`.
Without an unambiguous ledger pairing, the receipt keeps the transport's reason without inventing a successor.

Receipts and queued payloads stay under `$SHUTTLE_DATA_DIR` (default
`~/.shuttle`; trimmed, with a leading `~` expanded), outside the project. Payloads offered by hooks are retained there
for diagnosis. `SHUTTLE_CONFER_STATE_DIR` overrides native discovery when Pi
uses a nondefault runtime directory.

Attach up to eight files totaling 20 MiB with the same command:

```sh
shuttle message <address> "Here are the notes and plot" --attach notes.txt --attach plot.png
shuttle message <address> --attach results.pdf
```

Attachments are stable copies, stored outside the project on the receiving
host. The receiver verifies each SHA-256 digest before delivering a common
message containing local paths; each harness receives the same file references.
The JSON receipt's `files` list gives the copied name, path, digest, and size.
This confirms stored bytes, not that the recipient opened or understood them.
An identical retry returns the original receipt; changed bytes under the same
message ID are refused.

`--file` supplies message text. `--attach` transfers file bytes to another
session. `shuttle send-file` publishes artifacts to the human's IDE using
the existing owner-served file surface.

### Fleet / operator plumbing

Judge reach through the daemon, never with a shell probe.
On a userspace-Tailscale host, `curl`, `ssh` and `/dev/tcp` from a worker's shell do not route into the tailnet at all and can time out, while the daemon dials through the LocalAPI socket.
Use `shuttle remotes list` or the local daemon's `/api/v1/fleet` to check reach.
Remote creation and control go through the owning daemon.
The owner writes an armed constitution into its own store; dispatch does not wait for Git synchronization.
An unavailable owner fails the request; a missing fiber returns not-found with its host and identifier.
See [Connect your machines](../shuttle/remotes.md#verify-work-across-the-connection) for reach checks and shared-host API access.

| Command | Purpose |
|---|---|
| `shuttle remotes list` | List the fleet: the file's entries (disabled ones included) and the local daemon's discovered tailnet peers, with a SOURCE column (`configured` or `discovered`), a REACH column (`healthy <sha> up <uptime>`, `stale <last_error…>`, `unpolled`, or `?` when unknown), and a line on discovery's state; an unreachable daemon lists the file alone and says so. Validates paths, proxy/dial exclusivity, duplicate names, and port collisions. `--configured` lists and validates the file alone without asking the daemon (reach unknown); `--json` adds `discovery` (or `discovery_error`) to the normalized document and each remote's verbatim `health` and `build` objects from `/api/v1/fleet` (`null` when unknown) |
| `shuttle remotes add <name>` | Add or replace a remote in the file (`--port` or `--url`, `--ssh`, `--remote-port`, `--remote-socket`, `--display`, `--checkout`, `--multiplex`, `--tunnel-manager`) |
| `shuttle remotes rm <name>` | Remove a remote from the file; a discovered peer is suppressed with an `"enabled": false` entry instead |
| `shuttle remotes path` | Print the fleet file path (`~/.config/shuttle/remotes.json`) |
| `shuttle remote-control` | Show this daemon's managed Claude Remote Control host, its last exit screen and retry time; `--json` returns the full reconciled status from `/api/v1/remote_control` |
| `shuttle host` | Print this host's id, class, ambient mode and daemon listener (`--json` gives `{id, class, terminal, class_source, ambient, ambient_source, listen, listen_source, file, data_dir}`; the daemon reads its host id from it at boot, and the stop scripts put `heartbeat.stopped` in `data_dir`) |
| `shuttle host seed` | Write this host's id to `~/.shuttle/host` (or `$SHUTTLE_HOST_FILE`) unless it already holds one: `$SHUTTLE_HOST`, else the normalized hostname. `shuttle daemon install` runs it |
| `shuttle host class <class>` | Set this host's trust class in `~/.config/shuttle/host.json` (`single-user`, `shared-multi-user`, `exposed`) |
| `shuttle host ambient [on\|off]` | Print whether ambient mode is on and what decided it, or set `ambient` in `~/.config/shuttle/host.json`, keeping every other key (`--json` gives `{ambient, ambient_source, file}`; the source is `SHUTTLE_AMBIENT`, `file` or `default`). `$SHUTTLE_AMBIENT` overrides the file, and setting under it warns |
| `shuttle host check-owner` | Verify that a socket-class TCP listener belongs to this user, from `/proc/net/tcp{,6}` (a no-op for Unix listeners and off Linux) |
| `shuttle tunnels install [name ...]` | Write (and optionally bootstrap) autossh tunnels for the named remotes, or all enabled remotes if none are given (`--unit-dir`, `--log-dir`, `--autossh-path`, `--write-only`, `--dry-run`). launchd on macOS, systemd user units on Linux |
| `shuttle rex-setup` | Install `share/rex/shuttle.lua` into Rex's config directory (`~/.config/rex/shuttle/init.lua`) and append `require("shuttle").setup{}` to `~/.config/rex/init.lua` if not already present (`--config-dir`, `--source`, `--key`, `--dry-run`) |
| `shuttle validate-identity` | Check federated fiber UID invariants across daemon feeds (`--daemon-url`, repeatable, to check other hosts) |
| `shuttle contract` | Print the daemon-facing CLI contract version, used at daemon boot to detect an incompatible CLI |
| `shuttle mark-runtime <fiber>` | Stamp `shuttle.runtime` continuation fields (`--dispatched-at`, `--session`, `--run-id`, `--handed-off-at`, `--thread-exit-verb`; at least one required); daemon-facing, not for manual use |

!!! note
    `shuttle remotes`, `tunnels`, `validate-identity`, `contract`, and
    `mark-runtime` serve daemon and fleet plumbing. An adopter running
    shuttle solo will not need them.

### `shuttle channels dismiss <key> [--fiber <uid>]`

Set a channel aside in the human's Channels view, hide or show it, unpin it,
or clear a worker's line in it. Writes a family-board record of kind `dismissed` with the key as its text
and, when supplied, a fiber uid. A channel is keyed `channel:<name, lowercased>`
or `fiber:<top-level uid>`. The board writes:

- `office:<channel>:<ms>` to set one aside, where `<ms>` is when the newest
  wait in the channel began; the channel returns once something in it begins
  waiting later than that.
- `pin:<channel>:<ms>` to unpin one: it voids every pin up to `<ms>`.
- `hide:<channel>:<ms>` to take one out of the rail at `<ms>`. It stays
  findable through Jump to, and comes back once something in it begins waiting
  later than `<ms>`.
- `show:<channel>:<ms>` to bring a hidden one back: it voids every hide up to
  `<ms>`.
- `clear:<fiber uid>:<ms>` to clear a worker's line (its ✓): the line stays
  out of its channel while its latest message is no newer than `<ms>`, and its
  thread keeps everything. A close awaiting review is tempered instead, then
  cleared at the close.
- `unclear:<fiber uid>:<ms>` to undo a clear: it voids every clear of that
  thread up to `<ms>`.
- `line:<ms>:<item id>` to take one line that waits on no one (a post or a
  send, by the stream's item id) out of its channel at `<ms>`; it touches no
  other line and nothing that waits.
- `unline:<ms>:<item id>` to bring a cleared line back: it voids every clear
  of that line up to `<ms>`.

Dismissals reach every hub through the remote board feeds and are omitted from
family-board reading.

### `shuttle channels pin <key> [--fiber <uid>]`

Pin a channel in the human's Channels view. Writes a family-board record of
kind `pinned`; the channel stays listed while its latest pin is within the
board's 14-day reach and later than any unpin, and the board pins it again
when the human opens or answers it. Pins reach every hub as dismissals do and
are omitted from family-board reading.

### `shuttle channels order <key>...`

Order the rail of the human's Channels view. Writes a family-board record of
kind `ordered` whose `keys` lists channel keys in the human's order. The
newest record wins across the fleet; channels it does not name come before
the ordered ones, and channels waiting on the human float above both. The
board writes the order when the human moves a channel, and writes it again
while it stands, so it does not lapse with the board's 14-day reach. Orders
reach every hub as dismissals do and are omitted from family-board reading.

### `shuttle board [fiber] [--since 2h|<RFC3339>] [--all] [--turns] [--json]`

Read family activity from the local daemon, oldest first.
Omit the fiber inside a worker to use its own family; `--all` reads across families.
Each stretch of the human's turns, typed or spoken, reads as one line counting them per worker; `--turns` lists them in full, and `--json` always carries them.
Times print in the host's zone; a `--since` later than now is refused with the current time.

### `shuttle post <text|-> [--fiber <id>] [--to <address>] [--file <path>]...`

Post to a family board without waking anyone. A post is a line in its channel on the board, readable by everyone.
The current worker identifies the member, or `--fiber` selects one explicitly; `-` reads the text from stdin.
It prints one line saying it posted, as whom, to whom and with how many files; a post that printed it is on the board, and posting it again shows it twice.
Its address, the record's `to`, says whose attention it asks for: `--to human` or the human's name (`SHUTTLE_HUMAN`, else the first word of Git's `user.name`) records `{label: <name>}`, a person; `--to <fiber>` records that fiber. Without `--to` a post goes to the poster's orchestrator, and is unaddressed at the top level.
A post addressed to the human waits on them until they reply or clear it, or the poster says something newer (see `waiting` under [`/board/family`](api.md)).
Each `--file` attaches a readable regular file: it is recorded as a sent file, as `shuttle send-file` records it, and the post lists its absolute path in `files`.
Recording works offline.

### `shuttle show <path> [path...]` / `shuttle send-file <path> [path...]`

Publish readable regular files to the Shuttle board and the session/fiber sent-files
trail. `shuttle show` writes the same `file_sent` event with `"show": true` so a
thread page marks the new file unread and auto-advances to it when idle; `shuttle
send-file` records the delivery without `"show"`. Claude, Codex, Pi and Antigravity sessions use these commands. Paths are resolved to absolute
paths on the owning host; files must remain there for subsequent viewing.
The command validates the whole batch before recording one `file_sent` event.
It fails visibly if attribution or recording is unavailable.
`--caption "<text>"` records why the files are sent on that event; the board
shows it as the words of a file message that has none of its own.

Session identity comes from `--session`; else the calling harness session;
else the current tmux session's local ledger. A worker's tmux name identifies
its fiber. Outside a harness, pass `--session <native-session-id>`.

The calling harness session, which `send-file`, `message`, `find`, `claim`,
`migrate`, `thread` and a bare `handoff`, `close` or `rest` all use, is the
nearest harness among the process's ancestors that registered a receiver
through its hooks. Harnesses nest, and a child inherits every parent's
exported session id, so ancestry decides wherever it can, except that a
different id exported by the harness ancestry found names a nearer,
unregistered session of that harness, which is the caller (`message` keeps
the registered receiver as its sender). Otherwise the
environment does: `PI_SESSION_ID` when `AI_AGENT=pi` (Pi's own marker, which
also outranks an ancestry answer from another harness, since a Pi without a
receiver is invisible to ancestry); else the first set of
`ANTIGRAVITY_CONVERSATION_ID`, `CODEX_THREAD_ID`, `CLAUDE_CODE_SESSION_ID`,
`CLAUDE_SESSION_ID`, `PI_SESSION_ID`.
The event stream uses the same configuration as `shuttle hook event`; recording
works offline and confirms registration, not a completed client download.
The daemon also reads `SendUserFile` hook events as sends, with their `caption`.

### `shuttle sent-files ls <fiber> [--json]`

List a fiber's sent files from its owner, through the local daemon, newest first: when each was sent, its absolute path on the owning host, its caption, and the `/api/v1/file` URL that serves it.
Each path appears once, at its newest send, and at most 50 are listed.
`--json` gives `{fiber, uid, host, source, files}`; each file is the daemon's `/sent-files` entry plus `url`.

With the daemon unreachable, a fiber this host owns is read from the host's event stream instead, without URLs (`source` is `events` rather than `daemon`).
A fiber another host owns needs the daemon.
A daemon that listens on a unix socket has no URL to give.

### `shuttle tapestry <fiber> [--path | --url | --open | --json]`

Report a fiber's `tapestry.html`.
With no flag, print whether it exists, its path on this machine, the `/api/v1/file` URL the local daemon serves it at, and the fiber's `/thread` page.

| Flag | Prints |
|---|---|
| `--path` | Only the local path; fails when there is no copy here |
| `--url` | Only the tapestry's URL, or the thread page's when the fiber has no tapestry; fails when the daemon is unreachable or listens on a unix socket |
| `--open` | Opens it with `open` on macOS, else `xdg-open`: the local file, or the owner's URL for a fiber another host owns |
| `--json` | `{fiber, uid, host, exists, path, file_url, thread_url}` |

A fiber another host owns is read from its owner, so its tapestry has a URL without being synced here.
When the owner can't be reached, a Git copy on this host answers with a warning; without one the command fails.

### `shuttle sent-files clear <fiber> [--path <file>]`

Hide a fiber's sent-files trail without deleting artifact files or changing body embeds.
The command resolves the fiber's canonical UID and appends a `sent_files_cleared` event through the same host-local writer as `send-file`.
Without `--path`, both the Desk gallery and Channels hide sends at or before the latest whole-fiber clear timestamp for that UID.
With `--path`, the clear applies only to the exact absolute `fullPath`, leaving other files from the same send visible.
The path must be a nonempty absolute path; the command doesn't expand `~`, resolve relative paths, normalize the path, or require the file to exist.
Each path is hidden through the latest of its path-specific and whole-fiber cutoffs; a later resend appears normally.
Recording must be enabled and works while the daemon is offline.

A fiber assigned to another host is refused, even with `--local`.
Run the command on that host.
Unowned notes can be cleared locally.

### `shuttle transcript [--date YYYY-MM-DD] [--fiber <id|slug>] [--since HH:MM[:SS]] [--recorder HOST] [--json]`

Read a recorder's day transcript through the local daemon.
Each line shows the spoken time, speaker, card and text; `—` marks an unrouted line.
It includes speech that wasn't delivered to a worker.
Date defaults to today on the recorder, and `--since` is inclusive in the recorder's local time.
`--fiber` filters by UID, path or slug; `--recorder` selects the recording host, defaulting to the local daemon's host.
`--json` returns the complete response, including the recorder, date, routes and launch IDs.
Every delivered voice batch points to its first line with `shuttle transcript --since HH:MM:SS`, plus `--recorder HOST` when the worker is on another host.

With a session UUID instead, the command resolves a [session transcript](#session-transcript-search), not the spoken transcript.
