# Operating shuttle

What you need to drive shuttle from a session: when a fiber dispatches, the verbs that move it, how to claim a fiber into your own session, how hosts reach each other, and where to look when a card isn't doing what you expect. The operator guide at <https://cailmdaley.github.io/felt/> covers the board and daemon for humans.

## When a fiber dispatches

The daemon launches a worker for a fiber when all three hold:

1. The fiber lives in a store the daemon polls — from `FELT_STORES`, else `~/.config/felt/stores.json`, with no implicit default. A cross-project store such as `~/loom` brings in the project stores symlinked under it.
2. It carries a `shuttle:` block, written by `felt shuttle install` (oneshot), `repeat` (standing) or `pin` (pinned).
3. Its `status` is `active`. Nothing else gates dispatch: `open` is a draft, `closed` is awaiting review or finished, and tags never gate anything.

`shuttle.agent` chooses what runs, from `felt shuttle agents`; without one the fiber gets the registry default. `depends_on` only orders the board, folding a queued card under its head.

An `active` card can still refuse to dispatch; the daemon then shows it blocked with its reason instead of retrying every poll. On macOS the usual reason is `tmux_server_unavailable`: no tmux server is running, and the daemon won't start one itself (macOS would then charge every worker's file access to the daemon). The human restarts tmux from their terminal; re-dispatching won't help.

tmux owns the workers, so restarting the daemon never ends them; it re-adopts live sessions on boot. Restart it only with bare `shuttle-launch`, never `shuttle-launch --loop` (that is the respawn loop inside the `shuttle-daemon` session). If the daemon thinks a fiber is running but no tmux session exists, `felt shuttle dispatch <fiber>` reconciles it.

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
felt shuttle install <fiber> [--disabled]   # add a oneshot block, armed (or a draft)
felt shuttle repeat  <fiber> --schedule "0 9 * * 1-5" --tz Europe/Paris   # standing
felt shuttle pin     <fiber>                # pinned
felt shuttle reshape <fiber> [kind]         # change kind or schedule in place
felt shuttle set-agent <fiber> <agent-id>   # change the agent (--effort, --chrome)
felt shuttle pause   <fiber>                # back to draft, schedule kept; kills a live worker unless --no-kill
felt shuttle resume  <fiber>                # arm; a standing role awaiting review re-arms for its next tick
felt shuttle accept  <fiber>                # accept the run: standing re-arms for its next tick, pinned re-parks to the strip
felt shuttle close   <fiber> [--tempered=true|false]
felt shuttle reopen  <fiber> [--as-draft]   # requeue a closed fiber
felt shuttle uninstall <fiber>              # remove the block (see below)

felt shuttle status [<fiber>] [--all]       # the block and whether it will dispatch; --all adds remotes
felt shuttle ps                             # live workers
felt shuttle snapshot                       # the daemon's state
```

The daemon acts on each change at its next poll. `accept` and `resume` go through the owning daemon when it answers (`--local` writes here), and both keep the outcome: the last run's digest stays the card's headline until the next run writes its own.

## Claiming a fiber into your session

An interactive session becomes a fiber's worker through `POST /api/v1/claim`, and the daemon then treats it exactly as one it launched: it watches its liveness, shows it In flight, and expects the same two exits. Captures use this to adopt the fiber they just wrote, and a human uses it to drive any fiber from a session shuttle didn't start — a draft to begin now, an Awaiting review card to reopen, a running worker gone cold.

The examples use `http://localhost:4000`. On a shared host the daemon listens on a unix socket (`felt shuttle host` prints it); pass it to curl and keep the `localhost` host: `curl --unix-socket <path> http://localhost/api/v1/claim ...`.

```bash
# 1. only if a worker is live: stop it and park the fiber
felt shuttle pause <fiber>

# 2. claim, from inside the tmux session that becomes the worker
#    (the claim renames it to the worker name <leaf>-<uid>-shuttle)
curl -s -X POST http://localhost:4000/api/v1/claim -H 'Content-Type: application/json' \
  -d '{"fiber_id": "<fiber>", "tmux_session": "'"$(tmux display-message -p '#S')"'",
       "session_uuid": "<your transcript uuid>", "agent": "<registry id>"}'

# 3. arm, only after the claim succeeds
felt edit <fiber> --status active
```

Keep that order: arming before the claim lets the poller launch a duplicate worker while the daemon can't yet see you. `session_uuid` is optional but enables resume and transcript lineage. The claim is idempotent, so retry a lost response with the same body. Its errors say what to do first: `already_running` (pause the live worker), `closed` (`felt shuttle reopen`), `not_installed` (`felt shuttle install`), `session_not_found` (the tmux name didn't resolve). Stopping a live worker loses whatever sat in its input box, so `tmux capture-pane` anything visible first.

To claim from a Codex app conversation, send `"surface": "app"` with the exact conversation id as `session_uuid`, then arm. Shuttle verifies the id before recording ownership, renames nothing and starts no turn; it refuses an unreadable, missing or already-owned id. An existing native Codex conversation can be adopted the same way when this daemon's App Server can read its id. A dropped connection keeps your ownership: don't re-claim or start a replacement conversation.

From the claim on, you are the worker, and the skill's loop and exits apply.

## Remote hosts

Each host lists the others it can reach in `~/.config/felt/remotes.json`, each with an SSH target and tunnel port or a Tailscale `url`; `felt shuttle remotes list|add|rm|path` edits it. Reach runs one way: a hub that lists a spoke sees the spoke's cards and sessions, and the spoke sees nothing of the hub until its own file names it. To talk back from a spoke, register the hub with `felt shuttle remotes add <host> --url https://<host>.<tailnet>.ts.net`. On a host running userspace `tailscaled` that also needs an outbound proxy, which opens an unauthenticated gateway into the whole tailnet: set it up only on a single-user hub, never on a shared login node (the installation guide's "Tailscale as fleet transport" has the recipe).

Cards from a remote host reach the hub's board over this transport, not through git. If a remote card is missing, debug the tunnel and the store registration; pushing the store won't make it appear.

## When a card is missing

Check where the fiber was filed first: a repo-local `.felt/` the daemon doesn't poll never shows on the board. Then check that `felt shuttle status <fiber>` finds a block; most missing cards simply have none yet.

For what is actually installed and running, `felt setup receipt --json` reports the plugin bundles each harness loaded, which `felt` binary resolves (and any other felt build on PATH), hook compatibility, and the live daemon's contract; a cache directory existing is no proof that a bundle is loaded. `felt setup validate --source <checkout>` checks a local plugin candidate without changing anything. A daemon snapshot's `poll_health` shows stalled reads: rising `stalls` means a degraded input even while the daemon answers.

## When to uninstall

Closing a fiber leaves its block in place as the record; closing and uninstalling are separate decisions. Uninstall only to undo a mistake (the wrong fiber), to rebuild a block when project_dir, host and status should all be re-resolved from scratch (`reshape` covers kind and schedule), to take a fiber off the board entirely, or to hand it to a different dispatcher. A worker never uninstalls to close its own session.
