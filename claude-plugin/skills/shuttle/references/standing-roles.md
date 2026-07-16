# Standing Roles

A standing role is an **installed responsibility** — a cron-scheduled fiber that the daemon dispatches recurrently. One fiber, one durable concern, one place the user looks. Email triage. Daily PR survey. Weekly inbox catch-up. The pattern is the same: the human writes the constitution once; Shuttle dispatches a worker on the schedule; each run writes its work product into `outcome` and exits to awaiting-review; the human accepts; the cycle repeats.

This reference covers the lifecycle, the three things that should never share state, the kanban gestures by card state, the worker's exit handoff, and the common patterns + gotchas. The substrate basics (CLI verbs, fiber shape) live in SKILL.md; this is the depth you reach for when a standing role surprises you.

---

## The cyclic state machine

Lifecycle is `status` + `tempered`, uniform across kinds — that pair is the
whole lifecycle (no `enabled` flag, no `review.state` axis).

```
                      ┌──────────────┐
                      │ status:active │ ← armed; dispatches when cron.next(now) is due
                      │  (in flight)  │
                      └──────┬───────┘
                             │
                  cron tick │  daemon dispatches
                             ▼
                      ┌──────────────┐
                      │   running    │ ← live tmux worker (read from tmux, never stored)
                      │  (inFlight)  │
                      └──────┬───────┘
                             │
                  worker exits │  daemon writes status:closed (untempered)
                             ▼
                      ┌──────────────┐
                      │status:closed │ ← awaiting review; outcome holds latest digest
                      │ (awaitingRev)│   the don't-re-fire / anti-oscillation gate
                      └──────┬───────┘
                             │
                  user accepts │  via drag-to-inFlight/tempered or felt shuttle accept
                             ▼
                      ┌──────────────┐
                      │ status:active │ ← re-armed; next run = cron.next(now)
                      │  (in flight)  │
                      └──────────────┘
```

The `active → closed → active` document transition encodes "already ran this
occurrence." Due-ness is computed `cron.next(now)` — there is no stored
`next_due_at` gate. Closing a standing role for good is a separate decision
(`felt shuttle close` retires the responsibility, writing a verdict; per-run
acceptance is `felt shuttle accept`, which re-arms).

---

## The lifecycle axes

Standing roles carry two orthogonal concerns — naming which one a change touches
is the discipline that keeps the model clean.

| Concern | Lives in | Changes when |
|---|---|---|
| **Dispatch gate** | felt-native `status` | Armed `active`; paused/draft `open`; ran-this-cycle/awaiting `closed`. |
| **Verdict** | `tempered` (absent / true / false) | Worker exits → absent (awaiting). Accept (standing) → re-armed `active`. Reject → `false` (composted). Accept (oneshot) → `true` (tempered terminus). |

Due-ness is computed from the cron `schedule` vs `now`, not stored. A manual
ad-hoc dispatch fires from an armed role with a synthetic `adhoc-<unix_ms>` run
id; it does not change the schedule (which is computed, not consumed).

Concrete failure modes the model rules out:

- **Tempering a standing role no longer closes it.** A standing role awaiting
  review (`status: closed` + untempered) dragged to tempered/inFlight resolves to
  `felt shuttle accept`, which re-arms (`status: active`). A oneshot dragged to
  tempered is the `status: closed` + `tempered: true` terminus. Same gesture,
  kind-aware semantics (the classifier reads `shuttle.kind`).
- **Manual dispatch can't consume the next scheduled slot** because the slot is
  computed `cron.next(now)`, never a stored timestamp a dispatch could spend.

---

## Kanban gestures by card state

The kanban encodes the cycle as user gestures. **Two interaction modes** route to different verbs even for the same card:

- **Drag-and-drop** is "advance the card's state" intent. Drag-to-tempered = "I'm done, accept the run." Drag-to-drafts = "park it." Drag-to-inFlight on a dormant role = "fire it now."
- **Modal buttons** (Resume, New session) are "I'm NOT done — give me another worker on this same run" intent. They preserve outcome, don't advance the cycle.

Same card, same starting state, different button → different verb. The split matters because "advance" and "continue" are not the same gesture.

| Card state | Interaction | Verb fired | Effect |
|---|---|---|---|
| standing, **awaiting** (status:closed + untempered) | drag → tempered or inFlight | `felt shuttle accept` | Re-arms (`status: active`; next occurrence computed `cron.next(now)`). Outcome cleared. |
| standing, **awaiting** | modal **Resume** button | `felt shuttle resume` + dispatch (resume_mode=previous) | Re-arms and continues the prior session with the user's directive (session id from `shuttle.runtime.session_uuid`). Outcome preserved. |
| standing, **awaiting** | modal **New session** button | `felt shuttle resume` + dispatch (resume_mode=fresh) | Re-arms and starts a brand-new session on the same fiber. Outcome preserved. |
| standing, **armed (status:active)** | drag → inFlight | `felt shuttle dispatch --ad-hoc` | Manual ad-hoc run. Synthetic `adhoc-*` id. Schedule untouched. |
| standing, **draft (status:open)** | drag → inFlight | `felt shuttle reopen` | Arms it (`status: active`). Daemon picks up the schedule on next poll. |
| standing or oneshot, **running worker** | (any) | dispatch returns `already_running` | Classifier promotes the card to inFlight; user can attach via tmux. |
| any | drag → drafts | `felt shuttle pause` | Sets `status: open` + kills the live worker. Schedule preserved. |
| oneshot, closed (awaitingReview) | drag → tempered | `felt shuttle close --tempered=true` | Terminus. The responsibility is done. |
| oneshot, closed (awaitingReview) | drag → composted | `felt shuttle close --tempered=false` | Discarded. |

**Outcome-clearing rule.** Only `felt shuttle accept` clears the outcome — that's the cycle-advance verb, and a fresh outcome is the right precondition for the next run. Resume and New session preserve outcome because the run is *not* finalized; the user is iterating on it.

The kanban classifier (`classifyFiber`) reads only `status`, `tempered`, `kind`, and tmux liveness — no tags:

- `status: closed` → awaitingReview / tempered / composted by the `tempered` verdict
- running worker → inFlight (tmux liveness overrides, any kind)
- resting `kind: pinned` → pinned (the strip)
- `status: active` standing → scheduled (timeline, placed at next launch); `status: active` oneshot → inFlight
- `status: open` or no `shuttle:` block → drafts

The "live worker overrides" rule matters: the kanban shows ground truth (the running tmux session), read live, not stored file state.

---

## Run ids

| Kind | Format | Source |
|---|---|---|
| Scheduled | `YYYYMMDDTHHMMSS+0000` (UTC) | Minted from `now` at dispatch (a display label for the `Run:` prompt line) |
| Ad-hoc | `adhoc-<unix_ms>` | Generated by the daemon on ad-hoc dispatch |

The prefix is the discriminator. The worker's prompt header includes the run id; the daemon stamps it into `shuttle.runtime.run_id` at dispatch, alongside `session_uuid` and `dispatched_at` (the worker records nothing — the daemon owns the runtime block via `felt shuttle mark-runtime`). Resume reads the prior session id off `shuttle.runtime.session_uuid`.

---

## Worker exit handoff

**The daemon marks the role awaiting; the worker does not hand-edit frontmatter.**
A standing-role worker exits like any other worker: write the run's work product
into `outcome`, rewrite the constitution's `## Status` block, then exit via
`felt shuttle handoff`. On your exit the daemon writes `status: closed`
(untempered) to the document — that is the awaiting-review marker, the
don't-re-fire gate, and the human's accept anchor, all doc-representable. You do
**not** write status or review fields yourself; the daemon owns the awaiting
transition. `felt shuttle accept` re-arms the role — `status: active`, due-ness
recomputed from the cron — when the human accepts.

---

## Resume vs fresh

When the daemon dispatches a standing role, it decides whether to start the worker fresh or resume the prior Claude/codex session by `--resume <session-id>`.

| Trigger | Behavior |
|---|---|
| Scheduled cron dispatch | **Always fresh** (standing roles never auto-resume — `decide_continuation` is scoped to oneshots) |
| Ad-hoc dispatch (kanban drag, `--ad-hoc` flag) | **Always fresh** (forced in `Dispatcher.resolve_resume_intent/4`) |
| Kanban modal **Resume** on an awaiting run | Resume — the button carries `resume_mode: previous` (a transient dispatch parameter); the session id comes from `shuttle.runtime.session_uuid`, stamped by the daemon at dispatch |
| Daemon recovery / orphan adoption | Fresh |

The unifying rule: **resume is opt-in via deliberate gesture, not a default.** A standing role's scheduled and ad-hoc runs always start fresh; only the human's explicit Resume gesture reopens the prior transcript. The failure mode this rules out: dispatching a freshly-accepted run with `--resume <uuid>` lands the worker in a transcript whose last assistant turn was "Run accepted. Exiting." — it idles ("nothing new on the fiber") instead of running the responsibility. After accept, the cycle has rolled over; the next run is a *new* run.

---

## Constitution shape

```yaml
---
name: 'Constitution: <responsibility>'
status: active
tags:
  - constitution
  - standing
  - <topic>
shuttle:
  kind: standing
  agent: claude-opus            # or claude-sonnet, codex, pi-*
  host: <owning-daemon-host-id>
  project_dir: /abs/path/on/host
  schedule:
    expr: 0 9 * * 1-5            # standard cron
    tz: Europe/Paris
---

# Constitution: <responsibility>

<Body describing the responsibility — what to do, what to surface, what to
archive, what to escalate. Read fresh each run; the worker re-reads from
disk every dispatch.>

## Output Template

<How the worker should structure its outcome. Tight; skim-able. Section
headings the user expects.>

## Standing Exclusions / Edge Cases

<Anything the worker should know that isn't immediately derivable from
"do the thing." Special-case rules.>
```

Install via `felt shuttle repeat <fiber> --schedule "0 9 * * 1-5" --tz Europe/Paris`. The CLI validates the block before writing.

---

## Patterns

### Outcome as the work product surface

The kanban card shows the outcome verbatim. Standing-role outcomes are the user's daily skim. Three-section template (Action needed / Upcoming / Worth noting) works well; the email triage canary uses it. A standing role has at most one unaccepted work product: while awaiting review (`status: closed` + untempered), scheduled runs do not fire and ad-hoc dispatch refuses with an Accept-or-Resume message.

### Reading outcome at start

Standing-role workers should read the current outcome before doing anything else. In normal scheduled/ad-hoc runs it will be empty because `felt shuttle accept` cleared the prior work product. If a resume path carries a non-empty outcome, treat it as the still-active awaiting run you are continuing, not a second digest to stack on top.

### Tags that carry signal

`constitution` and `standing` are conventional. Neither is read by the daemon (dispatch is gated by the `shuttle:` block). They're for `felt ls -t standing` queries and conceptual marking only. Don't make a tag load-bearing for daemon behavior — promote the signal into `shuttle:` if it needs to gate dispatch.

### Session continuity lives in `shuttle.runtime`

The daemon stamps `session_uuid` / `dispatched_at` / `run_id` into `shuttle.runtime` at every dispatch; workers never learn their own UUID. That block is what the kanban Resume button reads — and `claude --resume <uuid>` reattaches the same transcript outside Shuttle when you want a manual look.

---

## Gotchas

- **`felt shuttle close` retires the responsibility; `accept` closes a run.** Closing a standing role is a verdict *on the constitution*, not on any single run — use it when the responsibility itself no longer matters. Per-run acceptance is `felt shuttle accept`, a separate verb. (`felt shuttle reopen` brings a retired role back if it turns out to matter after all.)
- **`status` is the dispatch gate.** The poller dispatches iff `status == "active"`. A standing role at `status: open` (draft/paused) or `status: closed` (awaiting/terminus) won't dispatch until armed. `felt shuttle resume` (open → active) or `felt shuttle accept` (closed-awaiting → active) is the way back.
- **`tempered` is the verdict axis.** Absent = awaiting (on a closed fiber); `true` = accepted (oneshot terminus); `false` = composted. For a standing role, accept re-arms (`status: active`) rather than writing `tempered: true`.
- **Ghost workers.** If `state.running` shows a fiber that has no live tmux session, the daemon's eligibility check blocks it from re-dispatching. `felt shuttle dispatch <fiber>` triggers a `reconcile_running_fiber` pass that clears stale entries.
- **Daemon restart does NOT end worker sessions — common misconception, closed out.** A worker runs in its own tmux session; the daemon only *watches* it (**tmux owns the worker process, Shuttle owns the watcher**). Bouncing the daemon cycles the watcher and rebinds `:4000`; every `shuttle-<id>` tmux session keeps running untouched and is re-adopted on boot. So an in-session worker can deploy its own daemon fix and restart freely — never hold a restart because "there's a live session." (Commit your diff first regardless — good hygiene, not because a restart would take it.) The restart command depends on how the daemon was launched (shell vs launchd) — see felt AGENTS.md → "Restarting the daemon does NOT end your session".
- **Resume of an awaiting standing role re-runs the worker against the digest.** `felt shuttle resume` re-arms it (`status: active`) for immediate dispatch. Useful for "actually, please rerun this with this directive" — pair with a review-comment carrying the directive.

---

## CLI quick reference (standing-role specific)

```bash
felt shuttle repeat  <fiber> --schedule "0 9 * * 1-5" --tz Europe/Paris
felt shuttle pause   <fiber>                # status: open + kill worker
felt shuttle resume  <fiber>                # status: active (re-arm; awaiting runs re-arm for immediate dispatch)
felt shuttle accept  <fiber>                # accept awaiting run; re-arm (next occurrence = cron.next(now))
felt shuttle dispatch <fiber> --ad-hoc      # manual ad-hoc run; synthetic adhoc-* id; schedule untouched
felt shuttle close   <fiber>                # retire the responsibility (reopen brings it back)
felt shuttle status                         # one line per shuttle-managed fiber
```

The kanban gestures map onto these verbs (see "Kanban gestures by state" above). When the gesture is unclear or you need explicit control, the CLI is always the escape hatch.
