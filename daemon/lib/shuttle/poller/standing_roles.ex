defmodule Shuttle.Poller.StandingRoles do
  @moduledoc """
  The poller-side standing-role lifecycle.

  Standing constitutions carry a cron `schedule:`. Armed (`status: active`),
  they fire when a scheduled occurrence has elapsed since they were last
  serviced, and a run's exit leaves them armed for the next tick: scheduled →
  running → scheduled. A run that needs the human asks (`shuttle ask`); Rest
  pauses the schedule (`status: open`) and a discarded close retires it. This
  module owns that lifecycle as the poller sees it: the catch-up due rule, the
  run conclusion on worker exit, the daemon-down dead-orphan reconciliation,
  parsing roles from candidate documents, and the display snapshots.

  It is distinct from `Shuttle.StandingRole`, the pure parser/cron module these
  functions read through. State-shaped helpers take the `Shuttle.Poller.State`
  struct and return updated state or values; the helpers they share with the
  rest of the poller live in `Shuttle.Poller`.
  """

  require Logger

  alias Shuttle.{LifecycleStore, StandingRole}
  alias Shuttle.Poller
  alias Shuttle.Poller.State

  # Downtime recovery for standing constitutions, on the tmux-scan substrate. A
  # standing constitution whose worker exited while the daemon was down never
  # fired `handle_worker_exit`, so its run was never concluded. Scan tmux: an
  # owned, active one with NO live session and NO live watcher has its run
  # concluded at its dispatch instant, so an occurrence missed meanwhile still
  # fires. Oneshots need no analog — a status:active oneshot with no live
  # session is simply eligible again next tick (retries collapsed into the
  # poll loop).
  #
  # `adopt_orphans` (init) and `reconcile_orphaned_sessions` (per-poll) handle
  # the *live* analog: a tmux session exists, we just aren't watching it.
  def reconcile_dead_standing_roles(%State{} = state, candidates, scan) do
    # This pass WRITES to fibers (the run's conclusion) on the strength of "no
    # live session", so it may only act on POSITIVE evidence: `scan` (the
    # cycle's `Poller.list_shuttle_sessions/1` result) is {:ok, sessions} —
    # including a genuine tmux-server-absent {:ok, []}. On {:error, :unknown}
    # (a wedged `tmux ls`, a timeout) the pass is skipped wholesale —
    # uncertainty counts as present (see Shuttle.Terminal), and a wedged tmux must
    # never mass-mark live standing constitutions dead. A truly dead orphan is
    # simply caught by the next healthy scan.
    case scan do
      {:ok, sessions} ->
        live =
          sessions
          |> Enum.map(&Shuttle.ULID.from_tmux/1)
          |> Enum.reject(&is_nil/1)
          |> MapSet.new()

        Enum.reduce(candidates, state, fn fiber, acc ->
          maybe_mark_dead_standing_role(acc, fiber, live)
        end)

      _incomplete ->
        Logger.warning(
          "tmux session scan unavailable (unknown state); skipping dead " <>
            "standing-role reconciliation this tick"
        )

        state
    end
  end

  defp maybe_mark_dead_standing_role(%State{} = state, fiber, live_uids) do
    fiber_id = Map.get(fiber, "id", "")
    shuttle = Map.get(fiber, "shuttle", %{})
    status = Map.get(fiber, "status", "")
    kind = Poller.block_kind(shuttle)

    cond do
      # Only the owning daemon writes a fiber's document. A fiber owned by
      # another host (or unowned — absent host:) is not this daemon's to mark.
      # Load-bearing gate: a remote restart must never reach across hosts.
      not Poller.host_owned?(shuttle, state.own_host_id) ->
        state

      # Oneshots: no on-down handling — status:active + no live session just
      # re-dispatches next tick (retries are the poll loop now).
      kind != "standing" ->
        state

      # Only an armed role has a run to conclude; a paused or retired one is
      # left as it stands.
      status != "active" ->
        state

      # A run already concluded (handed off, or never dispatched) has nothing
      # to write; this keeps an idle role from shelling the CLI every tick.
      Shuttle.Continuation.clean_handoff_since_dispatch?(fiber) ->
        state

      # A live watcher means the daemon is tracking this worker; its exit will
      # conclude the run through `handle_worker_exit`. Not a dead orphan.
      Poller.running_key(state, fiber_id) != nil ->
        state

      # A live worker session means the worker is still up —
      # `reconcile_orphaned_sessions`/`adopt_orphans` will adopt it. Not dead.
      MapSet.member?(live_uids, Map.get(fiber, "uid")) ->
        state

      # The locked writer reads the current document. A stale candidate
      # proves absence for its observed run only.
      true ->
        conclude_standing_run(fiber_id,
          observed: fiber,
          recovery: true,
          runner: state.runner,
          own_host_id: state.own_host_id
        )

        state
    end
  end

  # Conclude a standing run on worker exit: a worker that handed off already
  # did; one that exited without handing off gets `handed_off_at` stamped. The
  # constitution stays `status: active` for its next tick either way.
  # Best-effort: a failed write must not crash the exit-handling state machine
  # (the worker is already gone, and due-ness reads its dispatch stamp), so we
  # log and continue.
  def conclude_standing_run(fiber_id, opts \\ []) do
    case LifecycleStore.conclude(fiber_id, opts) do
      {:ok, _} ->
        :ok

      {:error, reason} ->
        Logger.warning("Failed to conclude standing run #{fiber_id} on exit: #{reason}")

        :error
    end
  end

  # Parse the standing constitutions straight from the candidate documents. The role's
  # display next_due is computed
  # from cron in `standing_role_snapshots`, and paused/retired are document
  # facts (status + tempered), so nothing daemon-owned is written.
  def standing_roles_from_candidates(candidates) do
    candidates
    |> Enum.reduce([], fn fiber, roles ->
      case standing_role_from_fiber(fiber) do
        {:ok, role} ->
          if StandingRole.standing?(role), do: [role | roles], else: roles

        {:error, _} ->
          roles
      end
    end)
    |> Enum.reverse()
  end

  # A standing constitution parsed straight from a fiber map's `shuttle:` block — a poll
  # candidate row or a `shuttle show` read alike, since both carry Shuttle's
  # resolved view of the block (`shuttle.resolved.{next_due,prev_due}` included).
  # The document is the truth — status and the cron schedule — and
  # the StandingRole reads exactly that, with no further CLI read.
  def standing_role_from_fiber(fiber) do
    fiber_id = Map.get(fiber, "id", "")

    case Map.get(fiber, "shuttle") do
      shuttle when is_map(shuttle) ->
        # Carry the candidate's uid onto the role for the snapshot's `:uid`
        # join key.
        StandingRole.from_map(fiber_id, shuttle, Map.get(fiber, "uid"))

      _ ->
        {:error, :no_shuttle_block}
    end
  end

  # The one standing-role dispatch rule: an armed role is due when a scheduled
  # occurrence has elapsed since it was last serviced. "Last serviced" is the
  # most recent of the dispatch/handoff markers and creation. Expressed against
  # the cron primitive as the lookback `now - last_serviced`: `due_by_cron?`
  # then asks "did a tick fire after the last service, at or before now?" —
  # i.e. is there an unrun occurrence. (A non-positive lookback ⇒ nothing
  # elapsed since service ⇒ not due, handled by `due_by_cron?`'s guard.)
  #
  # This makes the schedule SELF-CATCHING: a fire missed because the daemon was
  # down or the laptop asleep at the cron instant runs on the next poll instead —
  # however late. One catch-up fires, not a backlog: the run writes a fresh
  # dispatch marker, advancing the anchor to ~now, so the next poll sees only the
  # next FUTURE occurrence. Arming from a pause or retirement stamps the handoff
  # marker, so it waits for the next tick rather than catching up.
  def standing_role_due?(fiber) do
    with true <- Map.get(fiber, "status", "") == "active",
         {:ok, role} <- standing_role_from_fiber(fiber) do
      now = DateTime.utc_now()
      now_ms = DateTime.to_unix(now, :millisecond)
      lookback = now_ms - last_serviced_at_ms(fiber, now_ms)
      StandingRole.due_by_cron?(role, now, lookback)
    else
      _ -> false
    end
  end

  # Unix-ms lookback anchor: latest service or creation. Defaults to `now_ms`
  # (⇒ zero lookback ⇒ not due) only in the impossible case that neither is
  # known.
  defp last_serviced_at_ms(fiber, now_ms) do
    [
      last_service_event_ms(fiber),
      Poller.iso_to_unix_ms(Map.get(fiber, "created_at"))
    ]
    |> Enum.reject(&is_nil/1)
    |> case do
      [] -> now_ms
      list -> Enum.max(list)
    end
  end

  # Unix-ms of the most recent durable service event — the max of the fiber's
  # `shuttle.dispatched_at` and `shuttle.handed_off_at` (`Shuttle.Continuation`).
  # Arming a standing constitution stamps `handed_off_at` too (it concludes the
  # run), so it covers re-arms as well — no separate re-arm field. nil when neither is set (never
  # run). The cron self-catching invariant hinges on this advancing each run: a
  # fresh dispatch writes a newer `dispatched_at`, so the next poll sees only the
  # next FUTURE occurrence.
  defp last_service_event_ms(fiber) do
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

  def standing_role_snapshots(roles, now, state) do
    Enum.map(roles, fn role ->
      running? = Poller.running_key(state, role.fiber_id) != nil

      role
      |> StandingRole.to_snapshot(now, running?)
      # Display next_due is the schedule's next tick after now: `active` means
      # armed-for-the-next-occurrence. Falls back to the snapshot's value when
      # Shuttle resolved no occurrence.
      |> put_computed_next_due(role)
      |> Map.put(:uid, role.uid)
    end)
  end

  defp put_computed_next_due(snapshot, %StandingRole{} = role) do
    case StandingRole.next_due_from_cron(role) do
      %DateTime{} = next -> Map.put(snapshot, :next_due_at, DateTime.to_unix(next, :millisecond))
      _ -> snapshot
    end
  end
end
