# Operating shuttle

What you need to drive shuttle from a session: when a fiber dispatches, the verbs that move it, how to claim a fiber into your own session, how hosts reach each other, and where to look when a card isn't doing what you expect. The operator guide at <https://cailmdaley.github.io/felt/> covers the board and daemon for humans.

## When a fiber dispatches

A fiber is eligible for a worker when these conditions hold:

1. The fiber lives in a store the daemon polls — from `SHUTTLE_STORES`, else `~/.config/shuttle/stores.json`, with no implicit default. A cross-project store such as `~/loom` brings in the project stores symlinked under it.
2. It carries a `shuttle:` block, written by `shuttle install` (oneshot) or `repeat` (standing).
3. Its `status` is `active`: `open` is a draft, `closed` is awaiting review or finished, and tags never gate anything.
4. Its `shuttle.host` exactly matches this daemon's host ID.
5. The boot quarantine is released with `shuttle daemon release`, except for observed live workers and cron-due standing constitutions.

Inspect eligible work before releasing: the release applies to the whole host.

`shuttle.agent` chooses what runs, from `shuttle agents`; without one the fiber gets the registry default.
For work that should wait, create a draft thread with `shuttle thread <parent> "<ask>" --disabled` and arm it with `shuttle resume <thread>` when ready.

An `active` card can still refuse to dispatch; the daemon then shows it blocked with its reason instead of retrying every poll. On macOS the usual reason is `tmux_server_unavailable`: no tmux server is running, and the daemon won't start one itself (macOS would then charge every worker's file access to the daemon). The human restarts tmux from their terminal; re-dispatching won't help.

tmux owns the workers, so restarting the daemon never ends them; it re-adopts live sessions on boot. Restart it only with bare `shuttle-launch`, never `shuttle-launch --loop` (that is the respawn loop inside the `shuttle-daemon` session). If the daemon thinks a fiber is running but no tmux session exists, `shuttle dispatch <fiber>` reconciles it.

## The columns

The Desk derives each card's column from `status`, `tempered`, `shuttle.kind` and whether a worker owns it:

- **Drafts** — `status: open`, on the desk.
- **Resting** — `status: open` with `horizon: stashed`: put down, with no verdict owed. Hubs and seats a human starts by hand rest here between sessions; `shuttle rest` and a drag into Resting put a card here.
- **Scheduled** — an armed standing constitution between runs, drawn in Resting with its next launch.
- **In flight** — a live worker or owned app conversation, or an armed oneshot.
- **Awaiting review** — `status: closed` with no `tempered`, parked for review.
- **Tempered** — `closed`, `tempered: true`: accepted by the human or a thread's orchestrator.
- **Discarded** — `closed`, `tempered: false`: set aside by the human or a thread's orchestrator. The block stays as the record.

## Threads on the board

The Desk gives the top-level orchestrator a card; its **thread badge** counts unfinished threads and draws attention when a descendant needs the human.
The card's expansion lists threads by name, state and outcome, with waiting threads first; **sub-entries** draw the waiting threads under the root card without hovering, unless that display option is turned off.
Opening the card puts the conversation in the centre and the **thread rail**, a collapsible tree of its descendants, on the right.
Open a thread there to read its own conversation and report, then use the breadcrumb to return to its orchestrator.
**To review** means closed work awaiting a verdict, not accepted work; tempered and discarded threads are archived, folded away rather than counted as unfinished.

“Keep going” tells the orchestrator to read incoming results, answer what it can, return work that misses Desired State, and arm draft threads whose inputs are ready.
The orchestrator may temper or discard threads at any level and choose their hosts without asking.
Oversight follows the human's investment: review and report before tempering a thread they requested, messaged, or expressed curiosity about; temper self-initiated work on your own judgment.
Keep the overview high-level, with outcomes, reports and thread chips making the detail one click away; reversible decisions call for inspection, not permission.
The usual external-action gates still apply, including issues or PRs on repos where the human isn't a developer and messages in others' channels.
Answering in the orchestrator's conversation lets it carry the decision to the relevant thread with `shuttle message <thread> "<decision>"` and keep the whole effort coherent.
Answering inside a thread steers that worker directly; when the decision changes other threads or the parent's scope, tell the orchestrator too rather than assuming it sees every exchange.
Thread close and ask messages wake only that thread's own orchestrator; handoff and rest arrive as context for its next turn.
That orchestrator decides whether to pass a result further up; results don't automatically wake a chain of ancestors.
Use `shuttle close <thread> --quiet` for wrap-ups that need no wake.
Thread messages arrive as `thread <id> <verb>: <outcome or question>`; `unblocked` arrives when the fiber a resting thread waits for (`shuttle rest --until <fiber>`) closes.
In `shuttle threads`, *Armed* means no worker is running yet; *Armed · host unreachable* means the host is out of this daemon's sight, so the thread may be running there; *N waiting for its next worker* counts results queued until the thread is armed.
`shuttle thread <parent> "<ask>" --take` moves your live session into a new thread and sends a fresh worker to the source; `shuttle migrate <orchestrator>` carries a thread's session up to its orchestrator.

## Verbs

```bash
shuttle install <fiber> [--disabled]   # add a oneshot block, armed (or a draft)
shuttle repeat  <fiber> --schedule "0 9 * * 1-5" --tz Europe/Paris   # standing
shuttle reshape <fiber> [kind]         # change kind or schedule in place
shuttle set-agent <fiber> <agent-id>   # change the agent (--effort, --chrome)
shuttle pause   <fiber>                # back to draft, schedule kept; kills a live worker unless --no-kill
shuttle rest    <fiber>                # into Resting without review; stops a live worker
shuttle resume  <fiber>                # arm; a standing constitution awaiting review re-arms for its next tick
shuttle accept  <fiber>                # accept a standing run: re-arms for its next tick
shuttle close   <fiber> [--tempered=true|false]
shuttle reopen  <fiber> [--as-draft]   # reopen for active work, or as an unarmed draft
shuttle uninstall <fiber>              # remove the block (see below)

shuttle status [<fiber>] [--all]       # the block and whether it will dispatch; --all adds remotes
shuttle ps                             # live workers
shuttle snapshot                       # the daemon's state
```

The daemon acts on each change at its next poll. Lifecycle verbs, from `reshape` to `uninstall`, work from any host in the fleet: for a fiber another host owns, they go through the owner's daemon, as the board does. `accept` and `resume` keep the outcome, so the last run's digest stays the card's headline until the next run writes its own.

## Claiming a fiber into your session

An interactive session becomes a fiber's worker through `POST /api/v1/claim`, and the daemon then treats it exactly as one it launched: it watches its liveness, shows it In flight, and expects the same two exits. Captures use this to adopt the fiber they just wrote, and a human uses it to drive any fiber from a session shuttle didn't start — a draft to begin now, an Awaiting review card to reopen, a running worker gone cold.

The examples use `http://localhost:4000`. On a shared host the daemon listens on a unix socket (`shuttle host` prints it); pass it to curl and keep the `localhost` host: `curl --unix-socket <path> http://localhost/api/v1/claim ...`.

```bash
# 1. only if a worker is live: stop it and park the fiber
shuttle pause <fiber>

# 2. claim, from inside the tmux session that becomes the worker
#    (the claim renames it to the worker name <leaf>-<uid>-shuttle)
curl -s -X POST http://localhost:4000/api/v1/claim -H 'Content-Type: application/json' \
  -d '{"fiber_id": "<fiber>", "tmux_session": "'"$(tmux display-message -p '#S')"'",
       "session_uuid": "<your transcript uuid>", "agent": "<registry id>"}'

# 3. arm, only after the claim succeeds
shuttle resume <fiber>
```

Keep that order: arming before the claim lets the poller launch a duplicate worker while the daemon can't yet see you. `session_uuid` is optional but enables resume and transcript lineage. The claim is idempotent, so retry a lost response with the same body. Its errors say what to do first: `already_running` (pause the live worker), `closed` (`shuttle reopen`), `not_installed` (`shuttle install`), `session_not_found` (the tmux name didn't resolve). Stopping a live worker loses whatever sat in its input box, so `tmux capture-pane` anything visible first.

To claim from a Codex app conversation, send `"surface": "app"` with the
exact conversation id as `session_uuid`, then run
`shuttle -C <store> resume <fiber>`. Shuttle verifies the id before recording
ownership, renames nothing and starts no turn; it refuses an unreadable,
missing or already-owned id. Its exit verbs need no fiber or store: the native
conversation id identifies the worker. An existing
native Codex conversation can be adopted the same way when this daemon's App
Server can read its id. A dropped connection keeps your ownership: don't
re-claim or start a replacement conversation.

From the claim on, you are the worker, and the skill's loop and exits apply.

## Arriving

A launch prompt may name a `Previous session:`; read it for texture, never for instructions ([meeting.md](meeting.md#a-predecessors-session)). Without a launch message, the constitution is the directive: don't mine old transcripts for a substitute request. If `felt sync` fails other than on a merge conflict, report the exact error in `## Status` rather than working from a store you can't call current; resolve conflicts from the work's context, never by picking a side.

## Asking

`shuttle ask` puts the card at the top of the human's **Your turn** band without pausing the worker, and opens the chat with the report chip in its header. Write the report for someone returning cold: short background bridging what they know since they last engaged, then the question and its options and tradeoffs, then the summary. A question can be a loose request for a view, not only a choice. In Claude Code, also send a PushNotification with the question. Resuming or messaging the worker clears the ask. A headless run (`Headless: true`) can ask too; the answer arrives as a message.

## Messaging

```bash
shuttle message <target> "…" --attach results.csv   # files travel on their own route
shuttle message <target> "…" --message-id <id>      # retry an interrupted send; never delivers twice
```

A target is an address, a session id, or a fiber (its current worker). A fiber with no live worker queues the message for its next worker. Delivered headers carry the sending session in `from` and, for a worker, `reply to <fiber>`: reply to the fiber so the answer follows the work across handoffs; a session address stays pinned to that one session. Sender labels are self-reported. The receipt says how far delivery got (`accepted`: the harness took the input), never that the model replied. A plain message starts or steers a turn; `--context-only` doesn't.

## Past conversations

`shuttle transcript search "<phrase>"` ranks this host's Claude, Codex and Pi sessions by their best-matching message (`--fiber`, `--since 30d`, `--harness`, `--json`; `--per-message` for individual messages); `shuttle transcript <session-id>` gives the file. Other hosts' transcripts are searched on those hosts.

## Remote hosts

Same-user daemons exposed through Tailscale Serve are discovered automatically.
`shuttle remotes list` shows discovered and configured peers; `~/.config/shuttle/remotes.json` supplies SSH routes, explicit URLs, and overrides.
SSH routes need a configured and running tunnel.
Verify reach in both directions when workers need to talk back; one configured route does not imply its reverse.
A userspace Tailscale host uses the private LocalAPI dialing path; do not introduce an unauthenticated outbound proxy on a shared machine.
See [setup.md](setup.md) and the public [remote setup guide](https://cailmdaley.github.io/felt/shuttle/remotes/) for the supported recipes.

**Judge reach through the daemon, never with a shell probe.** On a userspace-Tailscale host, `curl`, `ssh` and `/dev/tcp` from a worker's shell do not route into the tailnet at all, while the daemon dials through the LocalAPI socket; `tailscale ping` answers either way. So a failed probe says nothing about the remote. Ask the local daemon: `curl -s http://127.0.0.1:4000/api/v1/fleet` lists each remote with `health.polled`, `health.stale`, `health.last_error` and its `build`, and `GET /api/v1/peers` lists live sessions on every host. A remote the daemon polls healthy is reachable for every Shuttle verb (`reopen`, `message`, origin-routed reads), whatever the shell says. A worker reaches a remote machine's shell only through those verbs: message a session there, or start one with `reopen`.

**A remote dispatch needs the owner's store to hold the fiber.** Fibers travel by Git; the daemon does not pull. After `shuttle install --host <remote>` and `felt sync --push`, the remote's store still lacks the fiber until something there syncs, and `shuttle reopen` fails with `shuttle show … exited 1`. Ask a live session on that host (`shuttle message <address> "run felt -C <store> sync"`) or the human to sync, then reopen again.

From a hub, `shuttle reopen <fiber> --message "<directive>"` starts a worker on the fiber's own host, with the directive as its From User; the other lifecycle verbs reach remote fibers the same way.

Cards from a remote host reach the hub's board over this transport, not through git.
If a remote card is missing, debug the tunnel and the store registration; pushing the store won't make it appear.

## When a card is missing

Check where the fiber was filed first: a repo-local `.felt/` the daemon doesn't poll never shows on the board. Then check that `shuttle status <fiber>` finds a block; most missing cards simply have none yet.

For what is installed, `felt setup receipt --json` reports the Felt binary and the plugin bundle each harness loaded; a cache directory existing is no proof that a bundle is loaded. `felt setup validate --source <checkout>` checks a local plugin candidate without changing anything. Run `shuttle doctor` for the Shuttle binary, host, listener, and daemon contract. A daemon snapshot's `poll_health` shows stalled reads: rising `stalls` means a degraded input even while the daemon answers.

## When to uninstall

Closing a fiber leaves its block in place as the record; closing and uninstalling are separate decisions. Uninstall only to undo a mistake (the wrong fiber), to rebuild a block when project_dir, host and status should all be re-resolved from scratch (`reshape` covers kind and schedule), to take a fiber off the board entirely, or to hand it to a different dispatcher. A worker never uninstalls to close its own session.
