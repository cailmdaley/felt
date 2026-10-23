defmodule Shuttle.Poller.SessionReconciliation do
  @moduledoc """
  Adoption of live workers the poller does not track.

  When the daemon restarts, the workers it launched keep running untouched
  (tmux owns the worker process; Shuttle only owns the watcher). This module
  re-adopts them so the daemon resumes supervising them — at boot
  (`adopt_orphans/1`) and on every poll (`reconcile_orphaned_sessions/3`).

  A terminal worker is adopted by its fiber's assignment, never by a tmux
  name: each untracked host-owned fiber whose unconcluded runtime names an
  execution (`Shuttle.Poller.Executions`) is adopted when a process holds that
  execution, with the holder's current tmux session as its label. A fiber
  concluded by a claim names nothing, so the worker that claimed it away is
  never adopted back onto it. An execution two live fibers name is held, not
  adopted, and reported in the snapshot until it heals. A closed fiber whose
  execution is still held — a worker that closed its fiber and did not exit —
  is stamped handed off and its worker stopped.

  Functions take the `Shuttle.Poller.State` struct and return updated state;
  the helpers they share with the rest of the poller live in `Shuttle.Poller`.
  """

  require Logger

  alias Shuttle.{Poller, WorkerProcess}
  alias Shuttle.Poller.{Executions, State}

  # Re-adopt every live worker at boot. The daemon was down or restarting; the
  # workers kept running.
  def adopt_orphans(%State{} = state) do
    state = Poller.boot_discover_candidates(state)
    listings_ok? = Enum.all?(state.felt_stores, &Map.has_key?(state.last_full_listings, &1))
    reconcile_orphaned_sessions(state, WorkerProcess.scan(state.runner), listings_ok?)
  end

  # Per-poll reconcile: adopt live workers that have no watcher. `scan` is the
  # cycle's process scan; an unknown scan cannot tell a live worker from a dead
  # one, so there is nothing safe to reconcile — retry next poll.
  def reconcile_orphaned_sessions(%State{} = state, scan, listings_ok?) do
    state = adopt_app_sessions(state)

    case scan do
      {:ok, procs} ->
        state |> adopt_assigned(procs) |> complete_adoption(listings_ok?)

      {:error, :unknown} ->
        Logger.warning("process scan unavailable; skipping worker adoption this tick")
        state
    end
  end

  # Complete the same authority boundary at boot or after deferred recovery.
  # A successful scan alone cannot prove absence when document discovery is
  # partial. Re-adoption publishes the live identities first; revocation then
  # touches only untracked fibers, preserving unchanged workers' epochs.
  defp complete_adoption(%State{adopted?: true} = state, _listings_ok?), do: state
  defp complete_adoption(state, false), do: state

  defp complete_adoption(state, true) do
    state = Poller.revoke_untracked_receivers(state)
    %{state | adopted?: true}
  end

  defp adopt_assigned(%State{} = state, procs) do
    state = reap_closing(state, procs)

    {state, holds} =
      state
      |> Executions.listed()
      |> Enum.filter(&(Poller.running_key(state, &1["id"]) == nil))
      |> Enum.reduce({state, %{}}, fn fiber, {state, holds} ->
        case Executions.handle(fiber) do
          nil -> {state, holds}
          handle -> reconcile_assigned(state, holds, fiber, handle, procs)
        end
      end)

    %{state | holds: Map.values(holds), unowned: unowned(state, procs)}
  end

  # Launches no fiber is assigned any more — a claim interrupted between its
  # release and its stamp leaves one — so nothing adopts, stops or resumes
  # them; the snapshot shows them so a human can.
  defp unowned(state, procs) do
    named =
      for fiber <- Executions.listed(state),
          %{uuid: uuid} when is_binary(uuid) <- [Executions.handle(fiber)],
          into: MapSet.new(),
          do: uuid

    tracked =
      for {_key, meta} <- state.running,
          uuid <- [Map.get(meta, :holder_uuid), Map.get(meta, :session_uuid)],
          is_binary(uuid),
          into: MapSet.new(),
          do: uuid

    for {uuid, proc} <- WorkerProcess.launches(procs),
        not MapSet.member?(named, uuid) and not MapSet.member?(tracked, uuid),
        uniq: true,
        do: %{session_uuid: uuid, tmux_session: Executions.session_of(state.runner, procs, proc)}
  end

  defp reconcile_assigned(state, holds, fiber, handle, procs) do
    held = WorkerProcess.find(procs, handle, state.runner)

    cond do
      # A closed fiber's worker is gone: conclude the dispatch, so its
      # conversation names no worker of it any more.
      held == nil and fiber["status"] == "closed" ->
        Poller.stamp_handoff_if_stale(state, fiber["id"], fiber)
        {state, holds}

      held == nil or match?({:error, :unknown}, held) ->
        {state, holds}

      (sharers = Executions.sharers(state, fiber["id"], handle)) != [] ->
        key = handle.uuid || inspect(handle.pane)
        {state, Map.put_new(holds, key, hold_row(fiber, handle, sharers))}

      fiber["status"] == "closed" ->
        {stop_closed(state, fiber, handle), holds}

      true ->
        {adopt_session(state, fiber["id"], handle, procs), holds}
    end
  end

  defp hold_row(fiber, handle, sharers) do
    %{
      fiber_id: fiber["id"],
      uid: fiber["uid"],
      reason:
        "shared conversation #{handle.uuid || "pane"}: also named by " <>
          Enum.join(sharers, ", ") <>
          "; its worker is neither adopted, stopped nor resumed until it exits " <>
          "or all but one of these fibers hand off"
    }
  end

  @doc """
  Adopts the live worker holding `fiber_id`'s execution, re-reading the fiber
  first: the adoption stands only if the fresh document still assigns the
  same execution, no other fiber shares it, and a process holds it. With no
  handle, the fiber's own execution is looked up (the dispatch path's
  refuse-and-adopt).
  """
  def adopt_session(state, fiber_id, handle \\ nil, procs \\ nil) do
    with {:ok, fiber} <- Poller.fetch_fiber_full(fiber_id, state),
         true <- fiber["status"] != "closed",
         %{} = current <- Executions.handle(fiber),
         true <- is_nil(handle) or Executions.same?(current, handle),
         [] <- Executions.sharers(state, fiber_id, current),
         {:ok, procs} <- if(procs, do: {:ok, procs}, else: WorkerProcess.scan(state.runner)),
         %{} = holder <- WorkerProcess.find(procs, current, state.runner),
         false <- tracked_worker?(state, procs, holder) do
      session =
        Executions.session_of(state.runner, procs, holder) ||
          Shuttle.Dispatcher.session_name(fiber_id, fiber["uid"], current.uuid || "pane") ||
          fiber_id

      adopt_live_session(state, fiber_id, fiber, current, session)
    else
      _ -> state
    end
  end

  # A process another tracked fiber's worker already is: adopting it too would
  # put one worker under two fibers.
  defp tracked_worker?(state, procs, holder) do
    root = WorkerProcess.worker_root(procs, holder).pid

    Enum.any?(state.running, fn {_key, meta} ->
      not Shuttle.AppWorkers.app?(meta.session) and
        case WorkerProcess.find(procs, Shuttle.WorkerBackend.handle(meta), state.runner) do
          %{} = proc -> WorkerProcess.worker_root(procs, proc).pid == root
          _ -> false
        end
    end)
  end

  defp adopt_live_session(state, fiber_id, fiber, handle, session) do
    runtime_key = Poller.runtime_key_for_fiber(fiber)

    # A re-adopted worker keeps the start its dispatch stamped; `now` only
    # when the stamp cannot be read.
    started_at = parse_time(handle.generation) || DateTime.utc_now()

    running_meta = %{
      state: "running",
      launch_error: nil,
      fiber_id: fiber_id,
      session: session,
      holder_uuid: handle.uuid,
      pane: handle.pane,
      session_uuid: handle.uuid,
      generation: handle.generation,
      agent_id: Poller.agent_id_from_fiber(fiber),
      role: get_in(fiber, ["shuttle", "role"]),
      uid: Map.get(fiber, "uid"),
      felt_store: Poller.owning_store(fiber_id, state),
      started_at: started_at,
      last_activity_at: started_at
    }

    running_meta =
      Map.put(running_meta, :context_harness, Poller.adopted_harness(state, running_meta, fiber))

    case Poller.start_watcher(state, fiber_id, running_meta) do
      {:ok, running_meta} ->
        Logger.info("Adopted live worker #{session} (#{handle.uuid || "pane"}) for #{fiber_id}")

        state
        |> Poller.put_running(runtime_key, running_meta)
        |> Poller.note_running(runtime_key)

      {:error, reason} ->
        Logger.warning("Failed to adopt #{fiber_id}'s worker #{session}: #{inspect(reason)}")
        state
    end
  end

  # A worker whose fiber was closed while it ran had a poll to end itself;
  # one still running then is stopped, unless the fiber was reopened.
  defp reap_closing(%State{closing: closing} = state, _procs) when map_size(closing) == 0,
    do: state

  defp reap_closing(%State{} = state, procs) do
    {due, fresh} = Enum.split_with(state.closing, fn {_id, entry} -> match?({:due, _}, entry) end)

    Enum.each(due, fn {fiber_id, {:due, handle}} ->
      with {:ok, %{"status" => "closed"}} <- Poller.fetch_fiber_full(fiber_id, state),
           %{} = worker <- WorkerProcess.find(procs, handle, state.runner),
           false <- tracked_worker?(state, procs, worker) do
        Logger.info("Stopping the worker of closed fiber #{fiber_id}, still running")
        Shuttle.WorkerBackend.stop(state.runner, handle)
      end
    end)

    %{state | closing: Map.new(fresh, fn {id, handle} -> {id, {:due, handle}} end)}
  end

  # A live worker whose fiber is closed: the worker's deliberate exit (closed
  # implies handoff), so stamp the clean-exit marker on its generation before
  # stopping it.
  #
  # The poll's listing predates this cycle's closure reconciliation, so the
  # fiber is read afresh: a worker that closed it and is exiting on its own
  # was concluded by that reconciliation, and is left to finish.
  defp stop_closed(state, fiber, handle) do
    with {:ok, fresh} <- Poller.fetch_fiber_full(fiber["id"], state),
         "closed" <- fresh["status"],
         %{} = current <- Executions.handle(fresh),
         true <- Executions.same?(current, handle),
         :ok <-
           Shuttle.Continuation.mark_handed_off(
             state.runner,
             Poller.owning_store(fiber["id"], state),
             fiber["id"],
             %{if_dispatched_at: current.generation}
           ) do
      Logger.info("Stopping the live worker of closed fiber #{fiber["id"]}")
      _ = Shuttle.WorkerBackend.stop(state.runner, Map.take(current, [:session, :uuid, :pane]))
    end

    state
  end

  defp adopt_app_sessions(state) do
    Enum.reduce(Shuttle.AppWorkers.active(), state, fn record, acc ->
      fiber_id = record["fiber_id"]

      if is_binary(fiber_id) and record["felt_store"] in state.felt_stores and
           Poller.running_key(acc, fiber_id) == nil do
        fetched =
          case Poller.fetch_fiber_full(fiber_id, acc) do
            {:ok, _} = found -> found
            _ -> Poller.fetch_fiber_full(record["uid"] || fiber_id, acc)
          end

        case fetched do
          {:ok, fiber} ->
            if Poller.host_owned?(fiber["shuttle"] || %{}, acc.own_host_id) and
                 Shuttle.AppWorkers.same_fiber?(record, fiber["id"], fiber["uid"]) do
              adopt_app_session(acc, fiber, record)
            else
              acc
            end

          _ ->
            acc
        end
      else
        acc
      end
    end)
  end

  defp adopt_app_session(state, fiber, record) do
    fiber_id = fiber["id"]
    session = Shuttle.AppWorkers.ref(record["session_uuid"])
    runtime_key = Poller.runtime_key_for_fiber(fiber)

    started_at =
      parse_time(record["started_at"]) ||
        parse_time(get_in(fiber, ["shuttle", "runtime", "dispatched_at"])) ||
        DateTime.utc_now()

    running_meta = %{
      state: Map.get(record, "launch_state", "running"),
      launch_error: record["last_error"],
      fiber_id: fiber_id,
      session: session,
      agent_id: record["agent_id"] || Poller.agent_id_from_fiber(fiber),
      role: get_in(fiber, ["shuttle", "role"]),
      uid: Map.get(fiber, "uid"),
      felt_store: record["felt_store"],
      started_at: started_at,
      last_activity_at: started_at
    }

    case Poller.start_watcher(state, fiber_id, running_meta) do
      {:ok, running_meta} ->
        Logger.info("Adopted app conversation: #{session}")

        state
        |> Poller.put_running(runtime_key, running_meta)
        |> Poller.note_running(runtime_key)

      {:error, reason} ->
        Logger.warning("Failed to adopt app conversation #{session}: #{inspect(reason)}")
        state
    end
  end

  defp parse_time(stamp) when is_binary(stamp) do
    case DateTime.from_iso8601(stamp) do
      {:ok, timestamp, _} -> timestamp
      _ -> nil
    end
  end

  defp parse_time(_), do: nil
end
