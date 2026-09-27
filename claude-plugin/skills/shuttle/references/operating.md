# Operating shuttle

Lifecycle verbs, kanban semantics, and the triage paths for "why isn't my card doing what I expect." The operator guide at <https://cailmdaley.github.io/felt/> carries the full board, cycle, and telemetry documentation; this page holds what an agent needs to act.

## Dispatch eligibility

The daemon dispatches a fiber when all of these hold:

1. The fiber lives in a felt store the daemon polls. Stores come from `FELT_STORES`, else the registry at `~/.config/felt/stores.json` (no implicit default); a cross-project store such as `~/loom` also exposes the project stores symlinked under its `.felt/`.
2. **The fiber carries a `shuttle:` block**, written by `felt shuttle install` (oneshot), `repeat` (standing), or `pin` (pinned).
3. **Felt-native `status:` is `active`** — the sole dispatch gate. `active` is armed, `open` is a draft, `closed` is awaiting review or a terminus.

The agent comes from `shuttle.agent`, resolved against the registry (`felt shuttle agents`); a fiber without one gets the registry default (authoring.md, "Agent selection").

**Tags never gate dispatch or the view.** The `shuttle:` block (`kind`, `schedule`, `agent`, `host`, `project_dir`) declares management; `status` and `tempered` drive dispatch and the columns; `depends_on` only orders the view (a queued card folds under its head). Tags are free-form.

**A card can sit `active` and still not dispatch.** The dispatch itself can refuse, and a refusal parks the fiber as a blocked row showing its reason rather than retrying every tick. On macOS one such reason is `tmux_server_unavailable`: no tmux server is running and the daemon couldn't reach the terminal to start one. The daemon refuses to start tmux itself, because macOS would then charge every worker's file access to the daemon's binary. The fix is a human restarting tmux from their terminal, not re-dispatching.

**Ghost workers.** If the daemon believes a fiber is running with no live tmux session, `felt shuttle dispatch <fiber>` reconciles the stale entry. **Daemon restarts never end worker sessions** — tmux owns the worker; the daemon re-adopts live sessions on boot. Start or restart the daemon only with bare `shuttle-launch`; never run `shuttle-launch --loop` by hand (that is the respawn loop meant to run inside the `shuttle-daemon` session).

## Kanban columns

The Desk admits fibers with a `shuttle:` block and cycle fibers, nothing else. Column membership derives from `status` + `tempered` + `shuttle.kind` + worker ownership:

- **Drafts**: `status: open` — dispatching nothing until launched (`felt shuttle pause` lands a card here).
- **Scheduled**: an armed standing role between firings, shown on the timeline at its next launch.
- **Pinned**: a resting `kind: pinned` role on the strip of perennial interfaces. A human starts it; the SKILL.md exit semantics govern it once running.
- **In flight**: a live worker or owned app conversation (any kind), or an armed oneshot — even one waiting on its dependencies.
- **Awaiting review**: `status: closed`, `tempered` absent. Parked for the human's verdict.
- **Tempered**: `status: closed`, `tempered: true`. Human-accepted.
- **Composted**: `status: closed`, `tempered: false`. Human-rejected (mooted, superseded). The block stays as the record.

A **cycle** is not work: a fiber tagged `cycle` with `start:` and `due:` civil days and a body whose first paragraph is the intention for that stretch of time. The Chronicle draws it as a band; membership is derived (worked during the span or due inside it), never listed.

**Snooze** writes frontmatter: dropping a card on a future day sets `due:` + `horizon: stashed` (it moves to Resting and returns on its due day); dropping it on today clears `due:`.

## Gestures by card state

Drag-and-drop advances a card's state; the modal buttons (Resume, New session) mean "not done — another worker on this same run" and preserve the outcome.

| Card state | Interaction | Verb fired | Effect |
|---|---|---|---|
| standing, **awaiting** | drag → tempered or inFlight | `felt shuttle accept` | Re-arms (`status: active`, next occurrence from cron). Outcome cleared. |
| pinned, **awaiting** | drag → tempered, strip, or drafts | `felt shuttle accept` | Re-parks to the strip (`status: open`, verdict cleared). |
| standing, **awaiting** | modal **Resume** / **New session** | `felt shuttle resume` + dispatch | Re-arms; continues the prior session with the directive, or starts a fresh one. Outcome preserved. |
| standing, **armed** | drag → inFlight | `felt shuttle dispatch --ad-hoc` | Ad-hoc run (`adhoc-*` id); schedule untouched. |
| standing, **draft** | drag → inFlight | `felt shuttle reopen` | Arms it; the schedule applies from the next poll. |
| oneshot, **awaiting** | drag → tempered / composted | `felt shuttle close --tempered=true/false` | Terminus / discarded. |
| any, **running worker** | any | dispatch returns `already_running` | Attach via tmux. |
| any | drag → drafts | `felt shuttle pause` | `status: open`, live worker killed, schedule preserved. |

Only `accept` clears the outcome (unless `--keep-outcome`): it is the cycle-advance verb, and a fresh outcome is the right precondition for the next run.

## Lifecycle verbs

The daemon picks these up on its next poll:

```bash
felt shuttle install <fiber>                # fresh oneshot, armed (status: active)
felt shuttle install <fiber> --disabled     # land in drafts (status: open)
felt shuttle repeat  <fiber> --schedule "0 9 * * 1-5" --tz Europe/Paris
felt shuttle pin     <fiber>                # pinned, schedule-less perennial role
felt shuttle reshape <fiber> [kind]         # change kind/schedule on an existing block, in place
felt shuttle pause   <fiber>                # status: open; kills live worker unless --no-kill
felt shuttle resume  <fiber>                # status: active
felt shuttle accept  <fiber>                # standing/pinned: accept the pending run
felt shuttle close   <fiber> [--tempered=…] # status: closed; verdict via --tempered
felt shuttle reopen  <fiber> [--as-draft]   # requeue a closed/reviewed fiber
felt shuttle set-agent <fiber> <agent-id>   # change shuttle.agent (axes: --effort, --chrome)
felt shuttle uninstall <fiber>              # remove the block — see below
```

Read-side:

```bash
felt shuttle status [<fiber>]               # table, or one block + dispatch assessment
felt shuttle status --all                   # local plus every configured remote
felt shuttle ps                             # live tmux workers
felt shuttle snapshot                       # the daemon's state
```

## Claiming a fiber into your session

An interactive session can become a fiber's worker through `POST /api/v1/claim`. The daemon registers it exactly as if it had dispatched it — liveness watcher, In-flight card, the same two-verb exit. This is how capture sessions adopt the fiber they just authored, and it serves any fiber a human wants to drive from a session shuttle didn't spawn: a draft to start on now, an Awaiting-review card reopened interactively, or a running worker whose cache has gone cold.

The examples use the single-user default, `http://localhost:4000`. On a shared or exposed host the daemon listens on a unix socket (`felt shuttle host` prints the address); pass it to curl and keep the `localhost` host, which the loopback check requires: `curl --unix-socket <path> http://localhost/api/v1/claim ...`.

**Terminal session:**

```bash
# 1. only if a worker is live: kill it and park safely (no dispatch gap)
felt shuttle pause <fiber>

# 2. claim — from inside the claiming tmux session (renames it to the
#    canonical <leaf>-<uid>-shuttle worker name)
curl -s -X POST http://localhost:4000/api/v1/claim -H 'Content-Type: application/json' \
  -d '{"fiber_id": "<fiber>", "tmux_session": "'"$(tmux display-message -p '#S')"'",
       "session_uuid": "<your transcript uuid>", "agent": "<registry id>"}'

# 3. arm — AFTER the claim, never before
felt edit <fiber> --status active
```

**App capture** (Shuttle-launched Codex app conversation): claim with `"surface":"app"` and the exact conversation id from the prompt as `session_uuid`, then arm. An existing native Codex conversation can also be adopted when this daemon's connected App Server can read its id; Shuttle verifies the identity before recording ownership. The claim does not start a turn or rename anything. An unreadable, missing, or already-owned id is refused; a connection failure keeps ownership and never triggers a replacement conversation.

The order is load-bearing: arming before the claim makes the fiber dispatch-eligible while the daemon can't yet see your session, and the poller spawns a duplicate worker. `session_uuid` is optional but worth wiring — it enables Resume-previous and transcript lineage. The claim is idempotent; retry a lost response with the same body. Errors: `already_running` (pause the live worker first), `closed` (`felt shuttle reopen` first), `not_installed` (`felt shuttle install` first), `session_not_found` (the tmux name didn't resolve).

Killing a live worker to claim loses whatever sat in its input buffer — `tmux capture-pane` anything visible first; the transcript survives. From the claim on, you are the worker and SKILL.md's loop and exit apply.

## Remote hosts

The fleet lives in `~/.config/felt/remotes.json`; each entry names a host and how to dial it — an SSH target plus a local tunnel port, or a Tailscale `url`. `felt shuttle remotes list|add|rm|path` inspects and edits it. The file is per host and reach is directional: a hub listing a spoke sees the spoke's cards and sessions; the spoke sees nothing of the hub until its own file names it. To talk back from a spoke, register the hub (`felt shuttle remotes add <host> --url https://<host>.<tailnet>.ts.net`). On a userspace-`tailscaled` host that also needs the outbound proxy, which is an unauthenticated gateway into the whole tailnet — it belongs on a single-user hub, **never on a shared login node**; the installation guide's "Tailscale as fleet transport" has the recipe.

`felt shuttle message` needs a live, supported integration on the receiver; unavailable receivers and pending native approvals are not bypassed. `--from` labels the sender when detection fails.

## Card missing?

First check where the fiber was filed (a repo-local `.felt/` the daemon doesn't poll is invisible to the kanban), then that `felt shuttle status` shows the block. Most "card missing" symptoms reduce to "no block installed yet."

**Remote-host cards arrive over the fleet transport, not store git-sync.** A constitution authored on a remote host — where `~/loom` is a different checkout — surfaces on the hub's board through the daemon's live read over the tunnel. **Don't push the store to make a remote card appear**; if one is missing, debug the tunnel and store registration, not the git state.

## Runtime truth

```bash
felt setup receipt --json                  # loaded bundles, felt binary, hooks, daemon contract
felt setup validate --source <checkout>    # non-mutating check of a local plugin candidate
```

The receipt reports what the harnesses actually loaded, which felt executable resolves (flagging a different felt build elsewhere on PATH), hook compatibility, and the live daemon's expected and observed contract; it rejects interrupted promotions and identity disagreements. A cache directory existing is not proof a bundle is loaded. Daemon snapshots carry `poll_health`: a stalled world read is reaped at its bound and rising `stalls` marks a degraded input even while the daemon stays responsive.

## When to uninstall — and when not to

The shuttle block is the dispatch contract: agent, kind, schedule, host. Closing a fiber doesn't remove it; the block stays as the record. **Closing and uninstalling are separate decisions.** `felt shuttle uninstall` earns its keep for:

1. **Mistake recovery** — wrong slug, immediate undo.
2. **Full rebuild** — converting kinds is normally `reshape`; uninstall + install only when project_dir, host, and status should be re-resolved from scratch.
3. **Archive from kanban** — the fiber should leave the board entirely rather than rest in Tempered or Composted.
4. **Tool boundary** — a different dispatcher takes ownership.

It is never how a worker closes its own session.
