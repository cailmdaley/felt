# Changelog

All notable changes to felt are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). A release's number
rises by a minor for new work, incompatible changes included, and its entry
leads with what breaks and how to upgrade; a major version marks an era the
maintainer declares ([Versioning](docs/dev/releasing.md#versioning)).

## Unreleased

### Fixed

- `felt check`, `felt show --citations`, `felt rename` and `felt nest` in 2.1.1 read a link title in parentheses (`[t](../meeting (title))`), a quoted title holding `)`, or a quoted title holding an escaped quote as part of the target, so such a link was reported broken and left pointing at the old path by a rename. They are titles again, as in 2.1.0.
- `shuttle daemon upgrade` in 2.1.1 could replace the release under a daemon that a supervisor started during the download, say that no daemon was running, and exit 0, leaving the old daemon running. It looks again after the swap and restarts what it finds. A daemon that answers with something other than its version is reported as such.
- `felt nest` and `felt rename` decide before the move whether a moved fiber's link reaches a file, so a link that reached nothing stays as written even when the move puts something at that path.
- The board derives the same slug as the CLI from a title with a leading `[tag]` or a dotted capital `İ`. `felt add` no longer suggests an empty slug.
- `felt update` and `shuttle daemon check` no longer ask to upgrade a daemon a checkout built whose contract level matches the CLIs; a source build carries no release version to compare.

## [2.1.1] — 2026-11-18

Fixes alone. Upgrade from 2.1.0 with `felt update`; a host that runs the Shuttle daemon follows it with `shuttle daemon upgrade`.

### Fixed

- `felt rename` and `felt nest` in 2.1.0 rewrote a link to a file whose name holds a space (`![m](../meeting notes.pdf)`, a macOS screenshot) when a fiber named like the text before the space moved, leaving a link to a file that does not exist; `felt check` reported such links as broken references and `felt show --citations` listed fibers that do not cite. A link's target keeps its spaces and ends only before a quoted title. If you renamed or nested a fiber with 2.1.0, look at `git diff` in the store for links to files with spaces in their names.
- `felt rm`, `felt rename` and `felt nest` no longer delete the symlink that mounts another repository into a store when they empty the directory behind it. Present since 2.0.0.
- A moved fiber carries its links to existing files and directories that are spelled like fiber references, such as `../Makefile`.
- `felt add --uid` refuses a UID held by any fiber of the enclosing store, and `felt add` refuses a path segment that starts with a dot.
- The board derives the same slug from an accented title as the CLI: `Café résumé` gives `cafe-resume`.
- The stale-daemon notice from `felt update`, `shuttle daemon check` and `shuttle doctor` says what happens with these CLIs: `shuttle message <fiber>` refuses, and messages already in a fiber's inbox wait.
- `shuttle daemon upgrade` fails before replacing anything when a daemon holds the port and does not answer; only nothing listening counts as no daemon. Where nothing restarts the daemon, its message says that `shuttle daemon start` runs in the foreground and that `shuttle daemon release` follows.

## [2.1.0] — 2026-11-17

What you get: `felt rename`, one slug convention that every verb holds a new slug to, a board with Channels, check-ins a session schedules for itself, and a `felt update` that says when it has left a Shuttle daemon behind. What breaks is Shuttle's: `shuttle inbox --play|--next|--stop` moved to `shuttle say`, the `/api/v1/deliver` request and its status words changed, and the board's Board view and Desk drag are gone. Stores, frontmatter and every 2.0.0 `felt` verb read as before; `felt add` refuses a slug outside the convention where it used to rewrite it.

### Upgrading from 2.0.0

- Stores used with `felt` alone need nothing: `felt update`, or the installer, and you are done.
- On a host that runs the Shuttle daemon, run `felt update`, then the command it names, `shuttle daemon upgrade`, which fetches the daemon release matching the CLIs, swaps it in and restarts the daemon. `felt update` replaces only the CLIs and ends by saying so when the daemon on the host is at another version. A 2.0.0 daemon left running beside 2.1.0 CLIs does not deliver messages to live workers: they wait in the fiber's inbox and arrive once the daemon is level. Until then `shuttle message <fiber>` refuses and names the command. A 2.1.0 daemon with an older CLI holds fresh dispatch and checks again every 30 seconds. The CLI contract is at level 49 (37 in 2.0.0). The HTTP API level (3; 1 in 2.0.0) is reported by `/api/v1/version` and not enforced.
- Upgrade every host of a fleet in one pass.
- A 2.0.0 daemon that owns a fiber does not understand what a 2.1.0 sender asks of it: it drops a message's attachments, queues a `--in`/`--at` check-in at once instead of at its time, and does not start a session for a dormant fiber.
- Thread results a 2.0.0 daemon had not yet placed (those still in `~/.shuttle/thread-outbox/pending/`, for an unresolved recipient or an unreachable owner) are not carried over, and a thread that closes or asks while the daemon is down for the upgrade is not reported to its orchestrator. Upgrade when that directory is empty and the host's threads are quiet.
- A message a 2.0.0 daemon was in the middle of delivering may arrive a second time after the upgrade, without the "Possible repeat" mark.
- Going back to 2.0.0 is unsafe while inbox entries are pending: an older owner delivers delayed entries at once and can repeat others. [The inbox](docs/dev/inbox.md) lists the hazards under Rollback.

### Added

- `felt rename <id> <new-slug>` changes a fiber's last path segment. The directory and its document are renamed together, descendants come along, and the fiber's intrinsic id is unchanged. Wikilinks, markdown links to the fiber's directory and to files inside it, and `inputs[].from` references to the fiber and its descendants are rewritten, across the enclosing store and repositories linked into it; `felt nest` rewrites the same links. Each fiber whose text still holds the old path is listed for review: prose, other project fields and reference-style links (`[x]: path`) are never rewritten. Run it from the store when the fiber lives in a repository the store links in: run in that repository's own checkout, it rewrites and reviews only that repository. It refuses a slug outside the convention, an existing destination, a companion file that already has the new document's name, a bare-form fiber (`.felt/<slug>.md`), and an id felt would have to guess at (a prefix or a stale path). An interrupted rename finishes when the command is repeated, or with `felt recover-move`, which does not print the review list. A fiber with a live Shuttle worker is renamed without stopping it: the daemon, `shuttle status`, `shuttle attach` and the fiber's inbox find it by its intrinsic id.
- One slug convention: a slug is lowercase letters and digits joined by single hyphens ([Fibers](docs/concepts/fibers.md#the-slug-convention)). `felt add`, `felt rename`, `shuttle thread --slug` and `shuttle role --new` refuse a new slug outside it and name the conforming form. Fibers that already have another slug (an underscore, a capital, a non-ASCII letter) keep it, stay addressable and linkable, can be moved and given children, and are listed as warnings by `felt check`.
- `felt update` ends by saying when the host's Shuttle daemon, running or installed, is at another version than the CLIs it installed, and names the command that brings it level. `shuttle daemon check` prints the same notice.
- `shuttle daemon upgrade` fetches the daemon release matching the installed CLIs, verifies it starts, swaps it in and restarts the daemon. It is for fetched releases; a daemon built from a checkout is deployed from that checkout.
- `felt add --uid <ULID>` creates a fiber under an existing identity, keeping its slug as spelled; the daemon uses it to carry a fiber to its owning host.
- `shuttle message <fiber> <text> --in 8h` or `--at <time>` schedules a check-in on the fiber's owning host, so it outlives the sending session; with no fiber it goes to the sender's own. `shuttle inbox ls <fiber> [--scheduled]` lists the entries waiting in a fiber's inbox on its owner and `shuttle inbox cancel <fiber> <id>` cancels one.
- `shuttle inbox put|pending|ls`: every inbox entry, for a fiber or a session, is created by one writer that records its delivery wishes (`--source`, `--turn`, `--if-costly`, `--not-before`) and refuses an unknown value. An entry waits until its `not_before` has passed. `shuttle inbox ls --json` shows the delivery attempt an entry is part of while it is open.
- Channels, the board's third view (hotkey `3`), takes the place of the Board view. Each line of work is a channel whose stream holds what its workers addressed to you: posts, questions, closes for your review and the files they sent, which unfold in place, HTML pages included. The rail lists channels that wait on you, are pinned, or were active in the last week, with unread counts. A ✓ (or `e`) clears a line, with an undo. Channel order, pins and hides are kept by the daemon, so every device agrees; `shuttle channels order|pin|dismiss` writes them.
- `shuttle.channel: <name>` in a constitution's `shuttle:` block chooses the channel it speaks in, and `shuttle thread` copies it to the thread it creates. Without it a constitution speaks in its orchestrator's channel, else its office's, else its own.
- `shuttle post --to human|<fiber>` addresses a post; one to the human waits on them until they reply or clear it. `--file` attaches files.
- `shuttle close --post "<conclusion>"` writes the closing post: its text becomes the fiber's `outcome` and the board's close line, and `--file` attaches files to it.
- `shuttle send-file --caption "<why>"` records why files were sent, and the board shows the caption with them.
- The board shows a Change page beside the fiber page of every constitution with a `project_dir`: the checked-out branch against the remote's default branch, uncommitted work included, or the GitHub PRs it follows, baked by the owning host each time the page opens. An optional `shuttle.change: {repo, base, prs}` names the change.
- `shuttle change --pr N` bakes a GitHub PR (for a merged one, the range it merged), `--list` lists the PRs a fiber follows, and `--cache` writes the bundle to `$XDG_CACHE_HOME/felt/changes/` instead of beside the fiber. `--base` is optional.
- `shuttle sessions --since <time>` lists every Claude, Codex and Pi session on a host with a transcript message since then, live or ended, with the fibers each worked on; `--host` reads another host through its daemon.
- `shuttle resume --carry` and `shuttle dispatch --carry`. A remote resume or dispatch sends this host's copy of the constitution to its owner; an owner that already holds the constitution keeps its own and prints how the two differ, unless `--carry` is given.

### Changed

- `felt add` refuses a slug outside the convention and names the conforming form; it used to rewrite `Foo Bar` to `foo-bar` silently.
- `shuttle message <fiber>` exits 1 without sending when this host's daemon is built for another CLI contract than this `shuttle`, or when the fiber's owning host reports that its own daemon and CLIs differ, and names the command that brings the daemon level. `shuttle doctor` reports the same difference as a mismatch.
- The held voice-line controls moved from `shuttle inbox` to `shuttle say`: `shuttle say --held` lists the held lines, and `--play`, `--next` and `--stop` play them. `shuttle inbox` manages message inboxes.
- Messages to a fiber wait in a durable inbox on the owning host, whether or not a worker is live. A message that asks for a turn starts a session for an armed fiber with no worker; it does not when the fiber is resting, a draft or closed, when the host's boot quarantine is held, or when its worker slots are full. The receipt says what happened: `woken`, `followed_up`, `delivered`, `held`, `starting`, `queued` or `scheduled`. `shuttle message --json` no longer prints `queued_for_next_worker`.
- `shuttle message --fresh` is deduplicated by `--message-id` and obeys the owner's launch gates: it starts a session only on an armed constitution and never reopens a closed fiber. A refusal gives its reason, and the same id can be sent again.
- `shuttle message` to a Claude session address goes to that session's native inbox, which queues it behind a running turn.
- `/api/v1/deliver` answers `delivery` as `context`, `input` or `fresh` (it was `message|input|resume|dispatch|context`), and its 409 `live` answer is gone. `/api/v1/dispatch` answers 202 with `queued: true` and reason `poller_busy` where it answered 504 for a slow poller: do not resend.
- The Desk has three columns, **Waiting on you**, **Working** and **Awaiting review**, over a shelf of **Drafts**, **Resting** and **Roles & standing**. Each family appears once, with a line for every member that waits on you. The selected card takes `a` (close for review), `s` (rest), `t` (temper) and `x` (discard); a verdict waits out an undo window.
- Every constitution opens on one view, the same from the Desk, a channel or a thread: its orchestrators, its head, its last words, the threads that wait or work, and a preview of its tapestry. A console docked at the bottom of the reader and of each channel is the board's one place to type to a worker.
- Back in the board's reader returns in one step to the view it was opened from, however far you went inside it. Escape, the ‹ button, the view's tab and the browser's Back do the same.
- Voice and Rex follow the board only on a click, never on a poll, a page load or the window coming forward.
- Resuming a constitution's past session from the board runs it as that constitution's worker without changing the card's lifecycle.
- When `shuttle claim` runs inside a harness, the worker ends when that harness process exits, and its terminal is given back to the human rather than closed.
- `shuttle find --since` and `shuttle transcript search --since` also accept hours (`12h`) and RFC 3339 times.
- `pi-fable` runs Claude Fable 5.2.

### Removed

- The board's Board view; `#/board` opens Channels.
- Dragging Desk cards, their context menu and Move…. Verdicts and rest are in a constitution's view and on the selected Desk row's keys.
- The board no longer draws `cold: true`; the key stays in the fiber and is ignored.
- `/api/v1/deliver` no longer takes `unless_live`, `message_after_launch` or `from_claim`; an owner ignores them if sent.

### Fixed

- A Codex wake whose terminal paste failed after text may have reached the composer is `unknown` (`ambiguous_delivery`) and is not pasted again at once. A delivery whose outcome stays unknown while its conversation is alive is sent once more, marked "Possible repeat"; a send held for approval is not. The daemon's `/sessions/input` answers 502 `terminal_input_ambiguous` for it and 503 `terminal_input_failed` when nothing was typed (in 2.0.0 a failed input was 502).
- The owning daemon no longer refuses a fiber message or a human line whose text begins with `-`, such as a Markdown list. From the CLI, pass such text after `--`, on stdin or with `--file`.
- A daemon that cannot run its CLI contract check, for example on a host out of processes, no longer treats that as a skew and holds dispatch; the check repeats every 30 seconds, and a skew clears once the levels match.
- A Claude transcript row over 1 MiB, such as a screenshot's tool result, no longer stops the daemon reading the transcript.
- `felt nest` and `felt unnest` refuse a bare-form fiber (`.felt/<slug>.md`) before writing anything; they used to report success and leave the document where it was, and for a bare-form fiber at the top of a linked repository (`<mount>/<slug>.md`) they also deleted the store's link to that repository. If you ran one there under 2.0.0, check that the repository is still linked.

## [2.0.0] — 2026-11-13

### Added

- A store's root fiber can declare `neighbors:`, the stores its links reach into. `felt check` prints one line per neighbour that isn't mounted (`loom: not mounted, 18 links`) instead of an error per link, and such links never resolve to a local fiber that merely shares their last segment.
- `felt add` warns when a new id redirects an existing short link or makes it ambiguous, naming each affected link, so the writer can fix it on the spot.
- Claude and Pi hooks bridge terminal program status through tmux to supporting outer terminals; `SHUTTLE_PROGRAM_STATUS=off` disables it.
- Shuttle supports Rex as its terminal backend with `"terminal": "rex"` in `host.json`.
- `felt sync` also syncs each git repository mounted in the store by a symlinked directory, with the same refusals and `--push`, naming each repository; a failing mount is reported by its path and makes sync exit non-zero after the others have run.

### Removed

- Sender proofs, cross-host attestations, sender claims and the board's sender marks. The `message-proof` command, the `POST /messages/attestations` route and the `context-mailbox put` proof, claim and daemon-sender flags are gone; contract level 35.
- The Codex desktop (App Server) worker backend. Codex workers run the Codex CLI in the host's terminal backend like Claude Code and Pi; dispatch, capture, resume and messaging use the terminal session's native identity.

### Changed

- Messages between sessions carry their text under one header, `[from life/vizier]`, with no hook preamble. The sender is what the sending CLI or API caller names; `--from` sets it. Old transcripts, queued mail and forwards from older peers read the same way.

### Fixed

- The felt skill gate refuses at most twice per session, then lets tool calls through with a note, so a session whose plugin hooks loaded after start (as after `/login`) is no longer locked out.
- `felt check` accepts markdown links to files and directories beside a fiber.
- The board draws delivered messages and thread notices as messages again, from transcripts in every header format.
- A project view linked into a store subtree that is itself a symlink into another repository belongs to the store its link names: felt finds the enclosing store one symlink hop at a time, so `find`, `show` and outer ids reach the whole store rather than the repository the bytes resolve into.

## [2.0.0-rc.2] — 2026-10-23

### Added

- Constitutions nested under a constitution are its threads: a child's lifecycle results reach its nearest orchestrator.

### Fixed

- Remote recovery respects a responding daemon regardless of whether it runs under
  tmux or a service supervisor. Booting daemons are allowed to finish, and queued
  restarts check liveness again before invoking the launcher.
- A launch rejected during daemon startup explains that nothing launched and can
  be retried. The composer preserves the message for an explicit retry.

## [2.0.0-rc.1] — 2026-10-05

### Breaking changes

- Shuttle has its own `shuttle` executable, installed alongside `felt`.
  Replace `felt shuttle <command>` with `shuttle <command>` in scripts and instructions.
  Manage the background service with `shuttle daemon start|stop|status|install|release`.
  The `felt` CLI owns fiber storage and preserves Shuttle frontmatter without interpreting it.
- Shuttle configuration lives under `~/.config/shuttle/`.
  Upgrade both CLIs and the daemon together; the daemon requires Shuttle CLI contract level 6.
  The Go archive contains both CLIs, and daemon archives are named `shuttled_<os>_<arch>.tar.gz`.
  Use `SHUTTLE_DAEMON=1` with the installer to fetch the daemon.
  Follow [Upgrade from 1.x](docs/shuttle/installation.md#upgrade-from-1x) to copy settings and refresh the supervisor.
- `accept --keep-outcome`, `SHUTTLE_LIFECYCLE_OFFLINE`, `migrate-runtime`, the `mode:` alias for `kind:`, and `POST /api/v1/inject` are removed.
  Accept and resume preserve the outcome; pass `--local` for offline lifecycle writes.
  Continuation keys belong under `shuttle.runtime`.

### Added

- Every felt-enabled Pi, Claude Code, and supported Codex session receives a durable handoff nudge.
  Claude Code nudges at the smaller of 75% context or 250,000 tokens, then at the smaller of 88% or 350,000 tokens.
  Pi and Codex retain the 500,000-token and 750,000-token defaults with the same percentages.
  Each level fires once per session, including resumes; `SHUTTLE_HANDOFF_*` environment variables configure the thresholds.
  Claude Code and Codex call `shuttle hook handoff` without starting Node; unknown Claude windows use the absolute limits.

- A [guided setup path](docs/shuttle/setup.md) covers the first worker, multiple hosts, terminal and browser opening, and the Codex desktop backend.
  The Shuttle skill includes an agent-guided setup reference.
- Daemons discover same-user peers through Tailscale; explicit remote configuration adds, overrides, or disables discovered peers.
  Shared hosts can use a protected Unix socket and SSH tunnels.
- Each browser can choose how Claude conversations open through Settings → Conversations.
  Codex desktop bridge settings survive daemon supervisor installation.
- Capture supports phone microphone input and reports the recorder's audio modes and the selected worker host's browser capabilities.
- Images pasted or dropped into the board composer travel to the worker's host as attachments.
  Stored attachments expire after 30 days.

### Changed

- The owning daemon serializes `shuttle accept` and `shuttle resume` with polling.
  Local lifecycle writes validate before changing the fiber.
- Arming through Shuttle requires a project directory.
  A forced start validates the directory before changing lifecycle state and refuses to launch in the felt store as a fallback.
- Worker execution and opening a conversation are separate choices.
  Terminal sessions stay in tmux; Codex app conversations retain their backend identity across daemon restarts.
- Intentional daemon restarts hold fresh dispatches until `shuttle daemon release`.
  Hosts can opt into automatic recovery after a qualifying hard crash with existing workers intact.
- `felt check --json` exits nonzero for error-level issues.
  Data-flow entries with `from:` are recognized without an `id:`.
  `show --citations` and `--consumers` render one line per edge; their JSON format is unchanged.

### Fixed

- Codex bridge startup cleanup handles a native process exiting while its socket appears, without deleting a replaced endpoint.
- Deployed workers do not inherit the daemon release's Erlang runtime environment.
- Exact fiber IDs take precedence over prefix completion, and ambiguous slugs report their candidates.
- `felt add -s` validates status and stamps closed fibers consistently with `felt edit`.
- Runtime command errors omit usage text; invalid command syntax still includes it.

## [1.1.0] — 2026-09-08

Shuttle joins felt in its first stable release: an agent dispatcher, a browser board, and a markdown work journal in one repository.
The CLI still works on its own; install the daemon when you want agents to carry work across sessions.

### Added

- Prebuilt Shuttle releases for macOS and Linux on arm64 and x86_64, including the Erlang runtime and UI.
  Install with `SHUTTLE=1` using the [installation guide](docs/shuttle/installation.md).
  Running agents requires tmux and an installed, authenticated agent CLI.
- Five board views: Desk for drafting, launching, and reviewing work; Day and Week for activity; Chronicle for work across days; Board for returned files.
  The Desk and temporal views adapt to phone-sized screens.
- Constitutions describe a desired state and carry a `shuttle:` block.
  One-shot tasks, pinned interactive roles, scheduled roles, and explicit handoffs share one lifecycle.
  Workers run in tmux and survive daemon restarts.
- A configurable agent registry for Claude Code, Codex, and Pi, with harness-grouped agent pickers.
  `felt shuttle agents init` seeds user overrides; `builtins: "restrict"` limits a host to its own records.
- Multi-host operation through `felt shuttle remotes` and SSH tunnels.
  Fiber content and edits route to the owning daemon; disconnected hosts retain visibly stale cached state.
- Projects can be registered from the board, with a local folder chooser or a remote absolute path.
- Session, commit, and activity ledgers connect work to its fiber across sessions.
  Dispatch prompts identify the previous session; transcript tools expose availability explicitly.
- Shared Felt and Shuttle skills for Claude Code, Codex, and Pi, with session context and activity hooks.
- Transactional Claude/Codex plugin setup with candidate validation, rollback, and verification of the cache the harness actually loads.
  `felt setup validate --source .` checks a candidate; `felt setup receipt --json` diagnoses an installation.
- Intrinsic fiber IDs and `updated-at` frontmatter preserve identity and recency through moves and checkouts.
  `felt backfill-ids` adds IDs to existing stores.
- `felt find` searches the enclosing store, while `felt ls` stays within the current project view.
  Explicit fiber IDs resolve across views, and `show --citations` / `--consumers` include cross-store references.
- `felt edit --set` / `--unset` manage extra scalar frontmatter; `felt tree -L` limits depth; compact summaries report body size.
- `felt check` reports malformed fibers, blank names, ambiguous references, and noncanonical host identities.

### Changed

- Markdown is the sole fiber data store.
  Body search, backlinks, and consumers are computed from the tree; editorial history belongs in git.
- Searches hide closed fibers by default and report their count.
  Use `-s closed` or `-s all` to include them; JSON output retains all matching statuses.
- Body search uses substring matching, with `-r` for regular expressions.
- Frontmatter serialization preserves extra-field order, and nesting preserves companion artifacts.
- Claude and Codex setup use their native plugin commands and caches.
  After installing, accept any hook-trust prompt in the harness so the hooks can run.
- The board shows fibers with Shuttle blocks and cycles.
  A `due:` date alone does not make a fiber a board task.
- Every daemon restart holds new launches and dead-worker resumes until `bin/shuttle release`.
  Already-running tmux workers continue; explicit force-dispatch bypasses the hold.
- Host identity is normalized and persisted in `~/.shuttle/host`.
  Armed work requires an explicit owning host and project directory.

### Removed

- The SQLite index, `felt index sync`, and the `felt history` command group.
  Leftover `.felt/index.db` files are inert and may be deleted.
- `felt ls --local`; use `felt ls` for the current view and `felt find` for the enclosing store.
- The `builtins: "replace"` registry mode; use `"restrict"`.
- The `claude-opus-chrome` alias; Chrome capability remains an explicit option on Claude agents.
- The retired `ralph` skill, legacy dependency-graph commands, and unused dispatcher machinery.

### Fixed

- Concurrent CLI writes serialize per fiber instead of overwriting one another.
- Bounded process execution and poller watchdogs distinguish an unavailable store from a missing fiber.
- Dispatch checks the selected agent executable and CLI/daemon contract before starting work.
  Failed reopen operations no longer spawn workers against closed fibers.
- Remote recovery retries after a tripped circuit breaker's cooldown instead of abandoning the host permanently.
- Daemon builds assemble a separate release tree before swapping, avoiding collisions with files held open on network filesystems.
- Supervisor installation captures a usable PATH; plugin hooks also work in GUI-launched sessions.
- Pi resume delivers its directive, and lowercase Pi tool names participate in recency and commit tracking.
- Temporal views refresh with the board, attribute activity through ledgers, and handle civil days in both tested timezones.
- Empty Desk columns explain how to create, launch, and review work.
- Updated document-renderer dependencies remove known production dependency advisories.
- The daemon rejects browser writes from unrelated origins and checks request hosts to protect the loopback API from DNS rebinding.
- Invalid daemon ports and remote timing settings are rejected before they reach runtime operations.
- Release publication waits for every platform's daemon artifact to build and boot successfully; the Homebrew formula uses the checksums of the published CLI archives.
- The installer checks downloaded versions before replacing an existing installation.
- Updated HTTP dependencies and the Go build toolchain address known security advisories; CI now checks Go, Elixir, and production JavaScript dependencies.

### Upgrading from 1.0

Review scripts that use the removed index/history commands, `ls --local`, or whole-word body search.
Use `felt find` where a script expects searches to reach beyond the current project.
Check older `shuttle.host` values against `~/.shuttle/host`, especially if the OS hostname contained uppercase letters or a DNS suffix.
After installing and starting Shuttle, verify its version and release the boot hold as described in the [installation guide](docs/shuttle/installation.md).

## [1.0.9] — 2026-05-18

### Added

- `felt init` now writes a store-owned `.felt/.gitignore` for felt's
  generated index and sync coordination files, without overwriting an
  existing user-edited ignore file.

### Fixed

- `felt setup claude` and `felt setup codex` on an existing install
  used `marketplace update`, which only re-fetches the marketplace's
  current pinned ref — so a `brew upgrade felt` from v1.0.7 → v1.0.8
  left the marketplace ref pinned at v1.0.7, plugin update saw no
  version diff, and the installed plugin stayed at the old content.
  Both setup paths now `marketplace add` with the current binary's ref
  (idempotent re-register for directory sources; ref-advance for git
  sources), then `plugin install`/`update` to apply. This is the path
  that actually moves users forward.

## [1.0.8] — 2026-05-17

### Fixed

- `felt ls -j` (and `felt check -j`, `felt tree -j`'s roots, projected
  listings) previously returned literal `null` instead of `[]` when no
  fibers matched. The SessionStart hook tripped over this for users with
  no active fibers: the pre-13d5d35 hook checked only for `[]`, so
  brew-upgrading the binary against an unrefreshed plugin started failing
  every session. `outputJSON` now normalizes nil slices to empty slices
  via reflection — every listing endpoint emits `[]` for empty results,
  and consumers never have to handle two shapes.

### Changed

- Plugin hooks (`claude-plugin/hooks/{session,remind}.sh`) are now thin
  shims that `exec felt hook <event>`. Hook behavior — find-root, fiber
  listing, SessionStart envelope, PreToolUse deny gate — lives in the
  binary as `felt hook session` and `felt hook pretool`. The plugin only
  needs refreshing when skill content changes. jq is no longer required
  by the hooks.

- Binary and integrations now update in lockstep so they can't drift:
  - `felt update` refreshes the Claude Code plugin (`marketplace update`
    + `plugin update`) after swapping the binary, and also re-runs
    `felt setup codex` if Codex integration is currently installed. One
    command, every layer current.
  - The homebrew formula has a `post_install` step that runs `felt setup
    claude` (and `felt setup codex` if Codex integration is detected),
    so `brew upgrade felt` keeps every integration in sync too. Skipped
    silently if the respective CLI isn't installed.
  - `felt setup claude` is now fully idempotent — if the marketplace is
    already registered, it takes the update path instead of erroring on
    duplicate add.

- Codex integration is now a real plugin via Codex's plugin marketplace
  rather than direct `~/.codex/hooks.json` wiring. Same plugin layout
  serves both agents: a new `.codex-plugin/plugin.json` sits next to the
  existing `.claude-plugin/plugin.json` inside `claude-plugin/`, both
  pointing at the same `hooks/` and `skills/` directories. Codex's
  marketplace install picks up the plugin from the felt repo's existing
  Claude-style `.claude-plugin/marketplace.json` (Codex reads it as a
  legacy-compat format). `felt setup codex` now:
  - Runs `codex plugin marketplace add <source>` to register the felt
    marketplace,
  - Auto-flips `features.plugin_hooks = true` in `~/.codex/config.toml`
    so Codex actually runs the bundled hooks (off by default in Codex),
  - Enables `[plugins."felt@cailmdaley-felt"]`,
  - Prunes any direct hook entries from `~/.codex/hooks.json` and any
    `~/.agents/skills/{felt,ralph}` symlinks left over from the pre-1.0.8
    direct-wiring model — Codex now sources both hooks and skills via the
    plugin.

  Existing Codex users will see the cleanup happen automatically on the
  next `felt setup codex` (or `felt update`, which calls it).

## [1.0.5] — 2026-05-04

### Fixed

- Unknown frontmatter keys round-trip through `ExtraFields` in
  `felt show --json` and `felt ls --json`, rather than being absorbed
  without a corresponding struct field.

## [1.0.4] — 2026-05-04

### Changed

- `felt show --json` now includes tool-owned frontmatter namespaces (any
  top-level YAML keys felt does not parse — `shuttle`, `tempered`,
  project-defined namespaces, etc.) as flat top-level JSON
  keys. Previously these were silently omitted, forcing programmatic
  consumers to fall back on `--field <key>` per-key reads. The lossy JSON
  output had concretely bitten the shuttle daemon's dispatcher: every
  fiber declaring `shuttle.agent: claude-opus` (or any non-default agent)
  silently downgraded to claude-sonnet because `fetch_fiber` got an
  empty `shuttle` map back. JSON now mirrors the round-trip-the-bytes
  contract felt already promises elsewhere. Backward-compatible: existing
  consumers that ignore unknown keys are unaffected.

## 1.0.3 — 2026-05-03

### Changed

- `felt ls <query>` now matches against the fiber's id (slug) in addition
  to its name, outcome, and structured frontmatter. Substring queries match
  any part of the full id, so `felt ls "dj-rico"` returns `dj-rico-contract`
  even when the fiber's name is "dj rico contract". Regex queries (`-r`) are
  also applied to the id. Exact queries (`-e`) accept either the full id or
  the id's basename (last path segment), enabling `felt ls -e "my-fiber"` to
  resolve `project/my-fiber` by basename.
- Help text for `felt ls --help` updated to document id/slug matching.

## [1.0.2] — 2026-05-03

### Fixed

- `felt setup codex` now dedupes felt hooks by path-suffix instead of
  exact-string match, so re-running setup with a different `--source`
  no longer leaves stale entries alongside the new ones in `hooks.json`.
  Reports clearly which case applies: "already installed" when nothing
  changed, "Updated" when the path moved (with the previous path
  shown), or "Removed N duplicate(s)" when stale entries were pruned.
- `felt setup codex --uninstall` no longer requires `--source` — felt
  hooks are identified by path suffix, so stale entries can be cleaned
  up even after the original checkout is gone.
- The SessionStart hook (`session.sh`) bails gracefully when `jq` is
  not installed, emitting the activate-felt directive plus a hint about
  installing `jq` for the fiber listing. Previously it would fail
  mid-pipeline with a noisy error. The PreToolUse hook already handled
  this case.

## [1.0.1] — 2026-05-03

### Changed

- `felt setup claude` no longer requires a local checkout. With no
  `--source`, it registers `cailmdaley/felt` directly from GitHub —
  Claude Code clones the marketplace itself. Tagged felt binaries pin
  the plugin to the matching tag (e.g. `cailmdaley/felt#v1.0.1`); `dev`
  builds track the default branch. Brew and curl users can run `felt
  setup claude` and have it just work.
- `felt setup codex` falls back to Claude Code's marketplace clone at
  `~/.claude/plugins/marketplaces/cailmdaley-felt/` when no `--source`
  is given, so a fresh `setup claude` followed by `setup codex` wires up
  both integrations without a manual checkout.

### Documentation

- README rewrite: opens by naming what felt is and defining "fiber" on
  first concrete use, drops the empty "lightweight" claim in favour of
  the concrete things that are true (single static binary, no daemon,
  rebuildable cache, plain-markdown source of truth), and names the
  audience early.

## [1.0.0] — 2026-05-03

The 1.0 release consolidates the directory-fiber pivot, an FTS5/SQLite
index, a per-fiber append-only history log, and a Claude Code plugin
marketplace install path. Plain markdown with YAML frontmatter remains
the source of truth — `.felt/index.db` is a rebuildable cache.

### Added

#### Directory-based fiber storage

- Each fiber lives in its own directory at `.felt/<path>/<slug>/<slug>.md`.
  Containment is the directory tree; nested IDs use paths
  (e.g. `bao-analysis/damping-prior`).
- Bare root fibers (`.felt/<slug>.md`) are recognised as entry-point
  fibers so a project's main narrative can sit at the root without a
  wrapping directory.
- Scoped resolution: `felt show second-fiber` walks up from the current
  fiber's containing directory before falling back to a global search,
  with exact-basename matches preferred over prefix matches.
- `felt nest <child> <parent>` and `felt unnest <id>` reshape the tree
  while rewriting `inputs.from` references.
- Symlinked walk roots are resolved once and visited tracking prevents
  cycles, so `.felt/` can safely symlink subtrees from elsewhere
  (e.g. the `loom` monorepo pattern).

#### SQLite index + FTS5 body search

- `.felt/index.db` indexes typed links, citations, tags, ASTRA
  summaries, and full-text body content. Rebuildable from the markdown
  tree at any time; no separate authoring path.
- `felt ls --body "query"` runs FTS5 search against fiber bodies.
- `felt show --citations` and `--consumers` surface narrative
  back-references and computational data-flow consumers via the index.
- File-backed views (`show <id>`) skip the index sync to stay fast and
  read-only-friendly.
- Hardened against `SQLITE_BUSY` contention under concurrent access.

#### Per-fiber append-only history log

- `felt history <id>` shows an editorial chain of summary events
  (newest first), plus mechanical `add`/`edit`/`rm`/`external_edit`
  events when `--mechanical` is passed.
- `felt history append <id> --summary "…"` records session continuity.
- `--kind <type>` typed events for downstream tools
  (e.g. `review-comment`).
- `--last 1` returns just the most recent event for handoff.

#### Claude Code plugin marketplace install

- `felt setup claude` registers the felt repository as a Claude Code
  plugin marketplace and installs the `felt` plugin via the official
  CLI (`claude plugin marketplace add` + `claude plugin install`).
  Idempotent — re-running is safe.
- The plugin bundles two skills (`felt`, `ralph`), a `SessionStart`
  hook that lists active and recently-touched fibers, and a
  `PreToolUse` hook that gates the first non-skill tool call until the
  felt skill has been activated.
- `--source <checkout>` or `$FELT_PLUGIN_DIR` selects which felt
  checkout to register; `--uninstall` removes the plugin.
- `felt setup codex` symlinks the same skills into `~/.agents/skills/`
  and configures Codex's `hooks.json` against the plugin's
  `session.sh` / `remind.sh` scripts.

#### CLI surface

- `felt check` lints fibers for broken refs, frontmatter issues,
  wikilinks inside code spans, absolute-path link targets, ASTRA
  reference fragments, and legacy-format residue.
- `felt edit` shorthand for one-level ASTRA structure: `--decision`
  with `--label`/`--rationale`/`--default`/`--option`, plus `--input`
  and `--insight`. `--option` accepts `\:` escapes.
- `felt show` targeted views: `--body`, `--decisions`, `--decision`,
  `--inputs`, `--outputs`, `--insights`, `--field <key>` for
  shell-friendly raw frontmatter extraction. `-d full` includes all
  ASTRA slices.
- `felt ls` emits `entry_point: true` for bare `.felt/<slug>.md` root
  fibers.
- `felt tree` shows containment hierarchy.
- `felt -C <dir>` runs felt as if started in `<dir>`.
- Tool-owned frontmatter (e.g. `shuttle:`) round-trips cleanly via
  `ExtraFields` preservation — felt doesn't parse or enforce, just
  preserves.

#### Migration

- `felt migrate` normalises legacy flat fibers into directory format,
  rewrites pre-existing `inputs` references, renames `title` →`name`,
  and strips legacy MyST anchors.
- `--dry-run` previews all changes before writing.

### Changed

- The relationship model is now: directory containment for hierarchy,
  `[[wikilinks]]` in bodies for narrative cross-references, and ASTRA
  `inputs.from` for computational data flow. The older `tapestry:*` and
  `tier:*` tag conventions are retired.
- Fiber `name` replaces the legacy `title` field. Bodies are plain
  markdown (no MyST anchors required).
- Status is opt-in: `felt add <slug> "name"` creates a statusless
  fiber. `felt ls` defaults to tracked (open + active); add filters
  widen to all statuses.
- `setup codex` now points hooks at the plugin's shell scripts
  directly, rather than `felt hook session` / `felt hook remind` CLI
  subcommands.

### Removed

- `internal/tapestry`, ASTRA runtime types, and Shuttle coupling moved
  out of the felt core.
- Public CLI: `tapestry`, `tag`, `untag`, `link`, `unlink`, `comment`,
  `upstream`, `downstream`, `graph`, `ready`, `prime`, `path`, and
  `export` are removed (most absorbed into `edit` / `show` / `ls`).
- Async Stop "conscience" hook retired in favour of the channel-nudge
  approach.

### Fixed

- `felt add` preserves explicit slug length instead of silently
  truncating.
- Setup heals broken skill symlinks before re-installing.
- `felt check` ignores wikilinks inside fenced code blocks and code
  spans.
- Session hook detects Claude Code sessions by transcript path rather
  than relying on environment presence.

[1.0.0]: https://github.com/cailmdaley/felt/releases/tag/v1.0.0
[1.0.1]: https://github.com/cailmdaley/felt/releases/tag/v1.0.1
[1.0.2]: https://github.com/cailmdaley/felt/releases/tag/v1.0.2
[1.0.4]: https://github.com/cailmdaley/felt/releases/tag/v1.0.4
[1.0.5]: https://github.com/cailmdaley/felt/releases/tag/v1.0.5
[1.0.8]: https://github.com/cailmdaley/felt/releases/tag/v1.0.8
[1.0.9]: https://github.com/cailmdaley/felt/releases/tag/v1.0.9
[1.1.0]: https://github.com/cailmdaley/felt/releases/tag/v1.1.0
[2.0.0-rc.1]: https://github.com/cailmdaley/felt/releases/tag/v2.0.0-rc.1
[2.0.0-rc.2]: https://github.com/cailmdaley/felt/releases/tag/v2.0.0-rc.2
[2.0.0]: https://github.com/cailmdaley/felt/releases/tag/v2.0.0
[2.1.1]: https://github.com/cailmdaley/felt/releases/tag/v2.1.1
[2.1.0]: https://github.com/cailmdaley/felt/releases/tag/v2.1.0
