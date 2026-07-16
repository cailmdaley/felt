defmodule Shuttle.Poller.StandingRoles do
  @moduledoc """
  The poller-side standing-role lifecycle.

  Standing roles are perennial constitutions with a cron `schedule:` — they
  arm (`status: active`, no verdict), fire when a scheduled occurrence has
  elapsed since they were last serviced, run to `status: closed` awaiting
  review, and re-arm on human accept. This module owns that lifecycle as the
  poller sees it: the catch-up due rule, the awaiting/park transitions on
  worker exit, the daemon-down dead-orphan reconciliation, parsing roles from
  candidate documents, and the display snapshots.

  It is distinct from `Shuttle.StandingRole`, the pure parser/cron module these
  functions read through. State-shaped helpers take the `Shuttle.Poller.State`
  struct and return updated state or values, mirroring the signatures they had
  inside `Shuttle.Poller`. Truly shared helpers (`role_kind/1`,
  `host_for_fiber/2`, `host_owned?/2`, `running_key/2`, `iso_to_unix_ms/1`,
  `fetch_shuttle_block/2`, `dependencies_satisfied?/2`, `list_shuttle_sessions/1`,
  `runtime_key_for_fiber/1`) stay in `Shuttle.Poller` and are called from here.
  """

  require Logger

  alias Shuttle.{Dispatcher, LifecycleStore, StandingRole}
  alias Shuttle.Poller
  alias Shuttle.Poller.State

  # Downtime recovery for perennial roles (standing + pinned), on the tmux-scan
  # substrate. A perennial
  # role whose worker exited while the daemon was down never fired
  # `handle_worker_exit`, so its document stays `status:active` with no live
  # session. Scan tmux: an owned, active role with NO live session and NO live
  # watcher → a standing role is marked awaiting (status:closed) so the cron
  # doesn't re-fire; a pinned role that died DIRTY is parked (status:open) back to
  # the strip so a dead interface neither sits stuck `active` in In-flight nor
  # relaunches. A pinned role that handed off CLEANLY before the daemon went down
  # is deliberately left `active` for an autonomous redispatch — and it never
  # reaches the park branch anyway: the `standing_role_dispatched_unexited?` gate
  # below treats a clean handoff (`handed_off_at >= dispatched_at`) as "not an
  # orphan" and skips the fiber. Oneshots need no analog — a status:active
  # oneshot with no live session is simply eligible again next tick (retries
  # collapsed into the poll loop).
  #
  # `adopt_orphans` (init) and `reconcile_orphaned_sessions` (per-poll) handle
  # the *live* analog: a tmux session exists, we just aren't watching it. This
  # pass is the *dead* analog for the kind that must NOT re-fire on its own.
  def reconcile_dead_standing_roles(%State{} = state, candidates) do
    # This pass WRITES to fibers (status:closed/open) on the strength of "no
    # live session", so it may only act on POSITIVE evidence: {:ok, sessions}
    # — including a genuine tmux-server-absent {:ok, []}. On {:error, :unknown}
    # (a wedged `tmux ls`, a timeout) the scan is skipped wholesale —
    # uncertainty counts as present (see Shuttle.Tmux), and a wedged tmux must
    # never mass-mark live standing/pinned roles dead. A truly dead orphan is
    # simply caught by the next healthy scan.
    case Poller.list_shuttle_sessions(state) do
      {:ok, sessions} ->
        live = MapSet.new(sessions)

        Enum.reduce(candidates, state, fn fiber, acc ->
          maybe_mark_dead_standing_role(acc, fiber, live)
        end)

      {:error, :unknown} ->
        Logger.warning(
          "tmux session scan unavailable (unknown state); skipping dead " <>
            "standing-role reconciliation this tick"
        )

        state
    end
  end

  def maybe_mark_dead_standing_role(%State{} = state, fiber, live_sessions) do
    fiber_id = Map.get(fiber, "id", "")
    shuttle = Map.get(fiber, "shuttle", %{})
    status = Map.get(fiber, "status", "")
    kind = Poller.role_kind(shuttle)

    cond do
      # Only the owning daemon writes a fiber's document. A fiber owned by
      # another host (or unowned — absent host:) is not this daemon's to mark.
      # Load-bearing gate: a remote restart must never reach across hosts.
      not Poller.host_owned?(shuttle, state.own_host_id) ->
        state

      # Oneshots: no on-down handling — status:active + no live session just
      # re-dispatches next tick (retries are the poll loop now). Standing and
      # pinned both reconcile (different terminal action, below); oneshots don't.
      kind not in ["standing", "pinned"] ->
        state

      # Only an armed role can regress into a phantom re-fire; closed/tempered
      # roles are already terminal/awaiting.
      status != "active" or not is_nil(Map.get(fiber, "tempered")) ->
        state

      # A live watcher means the daemon is tracking this worker; its exit will
      # flip the document through `handle_worker_exit`. Not a dead orphan.
      Poller.running_key(state, fiber_id) != nil ->
        state

      # A live tmux session (either name form) means the worker is still up —
      # `reconcile_orphaned_sessions`/`adopt_orphans` will adopt it. Not dead.
      Enum.any?(
        Dispatcher.session_names(fiber_id, Map.get(fiber, "uid")),
        &MapSet.member?(live_sessions, &1)
      ) ->
        state

      # The marker discriminator: only a role that was actually DISPATCHED but
      # never cleanly handed off is a dead orphan. The dispatch marker records
      # `dispatched_at`; the handoff marker records a clean exit — written by the
      # worker on a clean exit OR by a human accept/resume (which concludes the
      # run). A dispatch with no newer handoff is the daemon-down-across-exit
      # case. An armed role whose last run already handed
      # off (the "armed, not-yet-due" shape) is left alone so its next cron tick
      # fires.
      not standing_role_dispatched_unexited?(fiber) ->
        state

      # SELF-HEAL, don't close, on inverted markers — STANDING ONLY. An
      # inverted pair (`handed_off_at` earlier than `dispatched_at`) is NOT
      # physically impossible: it is the ordinary shape of any re-dispatched
      # role, because the PREVIOUS run's handoff stamp persists while the new
      # dispatch writes a newer `dispatched_at` (the re-arm-then-dispatch write
      # ordering alone produces a ~100ms inversion). For a STANDING role, the
      # safe reading of that shape with no live session is "conclude the
      # phantom run and stay armed" — stamping `handed_off_at = now` is
      # harmless because the CRON gates the next fire, and it avoids the
      # re-close-every-poll oscillation this branch was born for (a
      # corrupt-marker inference must never override the file's
      # `status: active`; commit 3d51276, "restart is not dispatch authority").
      #
      # For a PINNED role the same stamp is catastrophic: `handed_off_at >=
      # dispatched_at` IS the pinned autonomous relaunch trigger
      # (`deliberate_handoff_since_dispatch?`), so "healing" a pinned dirty
      # death manufactures a relaunch signal and the role loops forever
      # (heal → dispatch → dirty death → heal → …). A pinned role with an
      # un-exited dispatch and no live session is a dead interface regardless
      # of marker ordering; it falls through to the park branch below.
      kind == "standing" and standing_role_markers_inverted?(fiber) ->
        Logger.info(
          "Standing role #{fiber_id} has inverted runtime markers (handed_off_at earlier than " <>
            "dispatched_at) — corrupt, not genuinely in-flight; self-healing (stamping " <>
            "handed_off_at=now) and leaving armed instead of closing"
        )

        self_heal_inverted_markers(fiber_id, state)
        state

      # A dead ADHOC extra-run must not close the SCHEDULED standing role. An
      # ad-hoc (force-dispatched) run carries an `adhoc-<ms>` run_id; its dirty
      # death (daemon down across the exit) is caught here, but concluding the
      # standing role to awaiting-review on the strength of a crashed EXTRA run
      # would disrupt the cron cadence and demand a human temper. A completed
      # ad-hoc run reaches awaiting-review through `handle_worker_exit` instead
      # (worker exit → mark_standing_awaiting), so this reconciler only ever fires
      # on genuinely dead runs — leaving a crashed ad-hoc run's role simply armed
      # for its next scheduled tick is safe.
      kind == "standing" and dead_run_is_adhoc?(fiber) ->
        Logger.info(
          "Standing role #{fiber_id} has a dead ADHOC extra-run (daemon down across its exit) — " <>
            "leaving the scheduled role armed instead of marking awaiting"
        )

        state

      # Daemon-down analog of handle_worker_exit, split by kind. Only reached for
      # a DIRTY exit — the `standing_role_dispatched_unexited?` gate above already
      # skipped any role that handed off cleanly (a cleanly-handed-off pinned role
      # is left `active` for an autonomous redispatch, exactly as the live-exit
      # path leaves it):
      #  • standing → awaiting (status:closed) so the cron doesn't re-fire;
      #  • pinned   → parked (status:open) back to the strip, so a dead interface
      #    doesn't sit stuck `active` in In-flight and never relaunches itself.
      kind == "pinned" ->
        Logger.info(
          "Pinned role #{fiber_id} active with an un-exited dispatch but no live tmux " <>
            "session/watcher — session ended dirty while daemon was down; parking (status:open)"
        )

        mark_pinned_parked(fiber_id)
        state

      true ->
        Logger.info(
          "Standing role #{fiber_id} armed with an un-exited dispatch but no live tmux " <>
            "session/watcher — worker exited while daemon was down; marking awaiting (status:closed)"
        )

        mark_standing_awaiting(fiber_id)
        state
    end
  end

  # True iff the role was DISPATCHED but never cleanly handed off — a run that
  # began but whose exit the daemon never observed (it was down across the exit).
  # Read straight off the fiber's `shuttle:` block (`Shuttle.Continuation`):
  #
  #   • no dispatched_at             → never ran (or a human resolved it) → not an orphan.
  #   • handed_off_at >= dispatched  → clean exit observed                → not an orphan.
  #   • otherwise (dispatched, no newer handoff)                          → orphan (true).
  #
  # A human accept / resume / force-rearm SUPERSEDES the dead-orphan inference by
  # *concluding the run* — `LifecycleStore` folds `handed_off_at = now` into the
  # re-arm write, the same signal a clean worker exit leaves, since a human
  # accepting the run IS concluding it. This is what stops the standing-role
  # temper oscillation Cail hit on his morning-post / weekly-arxiv roles (a worker
  # that died without handing off was re-closed to awaiting on every reconcile).
  # Git-native, durable across a daemon restart, and needs no separate re-arm
  # field — the same `handed_off_at` covers both worker exit and human re-arm.
  def standing_role_dispatched_unexited?(fiber) do
    case Shuttle.Continuation.dispatched_at(fiber) do
      nil ->
        false

      dispatch_dt ->
        not at_or_after?(Shuttle.Continuation.handed_off_at(fiber), dispatch_dt)
    end
  rescue
    _ -> false
  end

  # True iff `dt` is non-nil and at or after `reference`.
  defp at_or_after?(nil, _reference), do: false
  defp at_or_after?(%DateTime{} = dt, reference), do: DateTime.compare(dt, reference) != :lt

  # True iff the fiber's markers are TIME-INVERTED: BOTH `dispatched_at` and
  # `handed_off_at` are present and `handed_off_at` is strictly EARLIER than
  # `dispatched_at`. This is the corrupt-marker subset of
  # `standing_role_dispatched_unexited?` (which also fires on the legitimate
  # "dispatched, no handoff at all" orphan, where `handed_off_at` is nil). Only
  # the inverted subset is impossible in a real run, so only it self-heals; a
  # genuine handoff-less orphan still closes.
  def standing_role_markers_inverted?(fiber) do
    with %DateTime{} = dispatched <- Shuttle.Continuation.dispatched_at(fiber),
         %DateTime{} = handed_off <- Shuttle.Continuation.handed_off_at(fiber) do
      DateTime.compare(handed_off, dispatched) == :lt
    else
      _ -> false
    end
  rescue
    _ -> false
  end

  # True iff the dead run's `run_id` marks it an ad-hoc (force-dispatched extra)
  # run — `StandingRole.ad_hoc_run_id/1`'s `adhoc-<ms>` form.
  def dead_run_is_adhoc?(fiber) do
    StandingRole.ad_hoc_run_id?(Shuttle.Continuation.run_id(fiber))
  end

  # Self-heal a run with inverted/implausible markers by concluding it — the same
  # `handed_off_at = now` stamp `LifecycleStore.conclude_run` folds into a human
  # accept. Best-effort (conclude_run is itself best-effort): a stamp miss just
  # means the next poll self-heals again, still without closing. Threads the
  # poller's runner + felt stores so the `felt shuttle mark-runtime` write resolves.
  def self_heal_inverted_markers(fiber_id, %State{} = state) do
    LifecycleStore.conclude_run(fiber_id, runner: state.runner, felt_stores: state.felt_stores)
  end

  # Mark a standing role awaiting (`status: closed`, untempered) by writing its
  # felt document on worker exit. Best-effort: a failed felt write must not crash
  # the exit-handling state machine (the worker is already gone; the dead-orphan
  # reconciler is the backstop), so we log and continue. No exit event is written
  # to any log — clean-exit is signalled by the worker's handoff marker.
  def mark_standing_awaiting(fiber_id) do
    case LifecycleStore.mark_awaiting(fiber_id) do
      {:ok, _} ->
        :ok

      {:error, reason} ->
        Logger.warning("Failed to mark standing role #{fiber_id} awaiting on exit: #{reason}")
        :error
    end
  end

  # Park a pinned interactive role back to the strip (`status: open`) on session
  # end. Best-effort, same contract as mark_standing_awaiting: a failed felt
  # write must not crash the exit-handling state machine (the worker is already
  # gone), so we log and continue. No exit event is written to any log.
  def mark_pinned_parked(fiber_id) do
    case LifecycleStore.park(fiber_id) do
      {:ok, _} ->
        :ok

      {:error, reason} ->
        Logger.warning("Failed to park pinned role #{fiber_id} on exit: #{reason}")
        :error
    end
  end

  # Parse the standing roles straight from the candidate documents. The role's
  # display next_due is computed
  # from cron in `standing_role_snapshots`, and awaiting/accepted are document
  # facts (status + tempered), so nothing daemon-owned is written.
  def standing_roles_from_candidates(candidates, state) do
    candidates
    |> Enum.reduce([], fn fiber, roles ->
      case standing_role_from_fiber(fiber, state) do
        {:ok, role} ->
          if StandingRole.standing?(role), do: [role | roles], else: roles

        {:error, _} ->
          roles
      end
    end)
    |> Enum.reverse()
  end

  # Standing roles are parsed straight from the felt document's `shuttle:` block.
  # The document is the truth — status,
  # tempered, and the cron schedule — and the StandingRole reads exactly that.
  def standing_role_from_fiber(fiber, _state) do
    fiber_id = Map.get(fiber, "id", "")

    case Map.get(fiber, "shuttle") do
      shuttle when is_map(shuttle) ->
        # Carry the candidate's uid onto the role so the snapshot's `:uid` join
        # key survives without the deleted uid cache.
        StandingRole.from_map(fiber_id, shuttle, Map.get(fiber, "uid"))

      _ ->
        {:error, :no_shuttle_block}
    end
  end

  def fetch_standing_role(fiber_id, state) do
    case Poller.fetch_shuttle_block(fiber_id, state) do
      {:ok, shuttle} ->
        StandingRole.from_map(fiber_id, shuttle)

      {:error, _} ->
        {:error, :no_shuttle_block}
    end
  end

  # Standing dispatch is gated entirely by the FELT DOCUMENT — not a runtime
  # review overlay and not a stored `next_due_at`.
  # A role dispatches iff its document says `status: active` with no verdict
  # (`tempered` unset) AND the cron schedule fired a tick inside the poll window
  # ending at now. `status: closed` (untempered) is the awaiting-review /
  # don't-re-fire signal — eligible?'s `status == "closed"` clause already
  # excludes it before this is reached, and the `active → closed → active`
  # document transition is the per-cycle "already ran this cycle" gate.
  # The one standing-role dispatch rule: an active role is due when a scheduled
  # occurrence has elapsed since it was last serviced. "Last serviced" is the most
  # recent of — the latest dispatch/handoff marker timestamp (durable across
  # restarts; a human re-arm stamps the handoff marker too), the in-memory re-arm
  # stamp, or the role's creation if it has never run. Expressed against the cron
  # primitive as the lookback `now -
  # last_serviced`: `due_by_cron?` then asks "did a tick fire after the last
  # service, at or before now?" — i.e. is there an unrun occurrence. (A
  # non-positive lookback ⇒ nothing elapsed since service ⇒ not due, handled by
  # `due_by_cron?`'s guard.)
  #
  # This makes the schedule SELF-CATCHING: a fire missed because the daemon was
  # down or the laptop asleep at the cron instant runs on the next poll instead —
  # however late. One catch-up fires, not a backlog: the run writes a fresh
  # dispatch marker, advancing the anchor to ~now, so the next poll sees only the
  # next FUTURE occurrence.
  #
  # Awaiting review can't relaunch: a role that ran is `status: closed` until a
  # human tempers (accepts) it back to `active`, and `eligible?`'s status gate
  # excludes closed before this is ever reached. So this rule only governs an
  # already-armed role; it never resurrects one pending review.
  def standing_role_due?(fiber, state) do
    fiber_id = Map.get(fiber, "id", "")

    with true <- Map.get(fiber, "status", "") == "active",
         true <- is_nil(Map.get(fiber, "tempered")),
         true <- Poller.dependencies_satisfied?(fiber, state),
         {:ok, role} <- fetch_standing_role(fiber_id, state) do
      now = DateTime.utc_now()
      now_ms = DateTime.to_unix(now, :millisecond)
      lookback = now_ms - last_serviced_at_ms(fiber, fiber_id, state, now_ms)
      StandingRole.due_by_cron?(role, now, lookback)
    else
      _ -> false
    end
  end

  # Unix-ms the role was last serviced — the most recent of its marker
  # timestamps, its in-memory re-arm stamp, and its creation. Defaults to `now_ms`
  # (⇒ zero lookback ⇒ not due) only in the impossible case that none are known.
  def last_serviced_at_ms(fiber, _fiber_id, state, now_ms) do
    [
      last_service_event_ms(fiber),
      # `rearmed_at` is keyed by runtime key (uid when present), so look it up by
      # the candidate's runtime key — matching how `lifecycle_transition` stamps.
      # It is the within-lifetime fast path; the durable handoff marker the
      # re-arm stamps (in `last_service_event_ms`) is the restart-proof backstop.
      Map.get(state.rearmed_at, Poller.runtime_key_for_fiber(fiber)),
      created_at_ms(fiber)
    ]
    |> Enum.reject(&is_nil/1)
    |> case do
      [] -> now_ms
      list -> Enum.max(list)
    end
  end

  # Unix-ms of the most recent durable service event — the max of the fiber's
  # `shuttle.dispatched_at` and `shuttle.handed_off_at` (`Shuttle.Continuation`).
  # A human re-arm stamps `handed_off_at` too (it concludes the run), so it covers
  # re-arms as well — no separate re-arm field. nil when neither is set (never
  # run). The cron self-catching invariant hinges on this advancing each run: a
  # fresh dispatch writes a newer `dispatched_at`, so the next poll sees only the
  # next FUTURE occurrence.
  def last_service_event_ms(fiber) do
    [
      Shuttle.Continuation.dispatched_at(fiber),
      Shuttle.Continuation.handed_off_at(fiber)
    ]
    |> Enum.reject(&is_nil/1)
    |> Enum.map(&DateTime.to_unix(&1, :millisecond))
    |> case do
      [] -> nil
      list -> Enum.max(list)
    end
  end

  def created_at_ms(fiber), do: Poller.iso_to_unix_ms(Map.get(fiber, "created_at"))

  def standing_role_snapshots(roles, running, now, state) do
    state = %{state | running: running}

    Enum.map(roles, fn role ->
      running? = Poller.running_key(state, role.fiber_id) != nil

      role
      |> StandingRole.to_snapshot(now, running?)
      # Display next_due is computed cron.next(now): `active` means
      # armed-for-the-next-occurrence, so the upcoming run is the schedule's next
      # tick, not a stored timestamp (the slice-2 cutover). Falls back to the
      # snapshot's stored value when the schedule won't parse.
      |> put_computed_next_due(role, now)
      |> Map.put(:uid, role.uid)
    end)
  end

  defp put_computed_next_due(snapshot, %StandingRole{} = role, now) do
    case StandingRole.next_due_from_cron(role, now) do
      %DateTime{} = next -> Map.put(snapshot, :next_due_at, DateTime.to_unix(next, :millisecond))
      _ -> snapshot
    end
  end
end
