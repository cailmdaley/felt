# Operating shuttle

What you need to drive shuttle from a session: when a fiber dispatches, the verbs that move it, how to claim a fiber into your own session, how hosts reach each other, and where to look when a card isn't doing what you expect. The operator guide at <https://cailmdaley.github.io/felt/> covers the board and daemon for humans.

## When a fiber dispatches

A fiber is eligible for a worker when these conditions hold:

1. The fiber lives in a store the daemon polls — from `SHUTTLE_STORES`, else `~/.config/shuttle/stores.json`, with no implicit default. A cross-project store such as `~/loom` brings in the project stores symlinked under it.
2. It carries a `shuttle:` block, written by `shuttle install` (oneshot), `repeat` (standing) or `pin` (pinned).
3. Its `status` is `active`: `open` is a draft, `closed` is awaiting review or finished, and tags never gate anything.
4. Its `shuttle.host` exactly matches this daemon's host ID.
5. The boot quarantine is released with `shuttle daemon release`, except for observed live workers and cron-due standing roles.

Inspect eligible work before releasing: the release applies to the whole host.

`shuttle.agent` chooses what runs, from `shuttle agents`; without one the fiber gets the registry default. `depends_on` only orders the board, folding a queued card under its head.

An `active` card can still refuse to dispatch; the daemon then shows it blocked with its reason instead of retrying every poll. On macOS the usual reason is `tmux_server_unavailable`: no tmux server is running, and the daemon won't start one itself (macOS would then charge every worker's file access to the daemon). The human restarts tmux from their terminal; re-dispatching won't help.

tmux owns the workers, so restarting the daemon never ends them; it re-adopts live sessions on boot. Restart it only with bare `shuttle-launch`, never `shuttle-launch --loop` (that is the respawn loop inside the `shuttle-daemon` session). If the daemon thinks a fiber is running but no tmux session exists, `shuttle dispatch <fiber>` reconciles it.

## The columns

The Desk derives each card's column from `status`, `tempered`, `shuttle.kind` and whether a worker owns it:

- **Drafts** — `status: open`.
- **Scheduled** — an armed standing role between runs, drawn in Resting with its next launch.
- **Pinned** — a resting pinned role, waiting for a human to start it; once running, the skill's exits govern it.
- **In flight** — a live worker or owned app conversation, or an armed oneshot, even one waiting on its dependencies.
- **Awaiting review** — `status: closed` with no `tempered`, parked for the human.
- **Tempered** — `closed`, `tempered: true`: the human accepted it.
- **Discarded** — `closed`, `tempered: false`: the human set it aside. The block stays as the record.

## Verbs

```bash
shuttle install <fiber> [--disabled]   # add a oneshot block, armed (or a draft)
shuttle repeat  <fiber> --schedule "0 9 * * 1-5" --tz Europe/Paris   # standing
shuttle pin     <fiber>                # pinned
shuttle reshape <fiber> [kind]         # change kind or schedule in place
shuttle set-agent <fiber> <agent-id>   # change the agent (--effort, --chrome)
shuttle pause   <fiber>                # back to draft, schedule kept; kills a live worker unless --no-kill
shuttle resume  <fiber>                # arm; a standing role awaiting review re-arms for its next tick
shuttle accept  <fiber>                # accept the run: standing re-arms for its next tick, pinned re-parks to the strip
shuttle close   <fiber> [--tempered=true|false]
shuttle reopen  <fiber> [--as-draft]   # requeue a closed fiber
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
missing or already-owned id. For an app worker's exit, include the same store
selector in the final `shuttle handoff` or `shuttle close` command. An existing
native Codex conversation can be adopted the same way when this daemon's App
Server can read its id. A dropped connection keeps your ownership: don't
re-claim or start a replacement conversation.

From the claim on, you are the worker, and the skill's loop and exits apply.

## Remote hosts

Same-user daemons exposed through Tailscale Serve are discovered automatically.
`shuttle remotes list` shows discovered and configured peers; `~/.config/shuttle/remotes.json` supplies SSH routes, explicit URLs, and overrides.
SSH routes need a configured and running tunnel.
Verify reach in both directions when workers need to talk back; one configured route does not imply its reverse.
A userspace Tailscale host uses the private LocalAPI dialing path; do not introduce an unauthenticated outbound proxy on a shared machine.
See [setup.md](setup.md) and the public [remote setup guide](https://cailmdaley.github.io/felt/shuttle/remotes/) for the supported recipes.

From a hub, `shuttle reopen <fiber> --message "<directive>"` starts a worker on the fiber's own host, with the directive as its From User; the other lifecycle verbs reach remote fibers the same way.

Cards from a remote host reach the hub's board over this transport, not through git.
If a remote card is missing, debug the tunnel and the store registration; pushing the store won't make it appear.

## When a card is missing

Check where the fiber was filed first: a repo-local `.felt/` the daemon doesn't poll never shows on the board. Then check that `shuttle status <fiber>` finds a block; most missing cards simply have none yet.

For what is installed, `felt setup receipt --json` reports the Felt binary and the plugin bundle each harness loaded; a cache directory existing is no proof that a bundle is loaded. `felt setup validate --source <checkout>` checks a local plugin candidate without changing anything. Run `shuttle doctor` for the Shuttle binary, host, listener, and daemon contract. A daemon snapshot's `poll_health` shows stalled reads: rising `stalls` means a degraded input even while the daemon answers.

## When to uninstall

Closing a fiber leaves its block in place as the record; closing and uninstalling are separate decisions. Uninstall only to undo a mistake (the wrong fiber), to rebuild a block when project_dir, host and status should all be re-resolved from scratch (`reshape` covers kind and schedule), to take a fiber off the board entirely, or to hand it to a different dispatcher. A worker never uninstalls to close its own session.
