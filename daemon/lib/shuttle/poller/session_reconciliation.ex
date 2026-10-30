defmodule Shuttle.Poller.SessionReconciliation do
  @moduledoc """
  Orphan adoption / live-session reconciliation for the poller.

  When the daemon restarts, the `*-shuttle` tmux sessions it launched keep
  running untouched (tmux owns the worker process; Shuttle only owns the
  watcher). This module re-adopts those live sessions so the daemon resumes
  supervising them — at boot (`adopt_orphans/1`) and on every poll
  (`reconcile_orphaned_sessions/3`). Both walk the live `*-shuttle` tmux
  sessions, map each back to its fiber by its `<leaf>-<uid>-shuttle` name
  through `candidate_session_lookup/1`, and either start a watcher over the
  live session, kill a session whose fiber has closed, or skip an unknown one.

  Functions take the `Shuttle.Poller.State` struct and return updated state;
  the helpers they share with the rest of the poller live in `Shuttle.Poller`.
  """

  require Logger

  alias Shuttle.Dispatcher
  alias Shuttle.Poller
  alias Shuttle.Poller.State

  # Re-adopt every live shuttle tmux session at boot. The daemon was down or
  # restarting; the workers kept running. Each live session is mapped back to its
  # fiber and re-watched (or killed if the fiber has since closed).
  def adopt_orphans(%State{} = state) do
    state = adopt_app_sessions(state)
    # An {:error, :unknown} scan (wedged tmux, timeout) means the session list
    # is UNCERTAIN, not empty — adopting off an empty read would boot the
    # daemon believing no workers exist. Skip; the per-poll
    # reconcile_orphaned_sessions adopts them as soon as tmux answers.
    case Poller.list_shuttle_sessions(state) do
      {:ok, sessions} ->
        state = Poller.boot_discover_candidates(state)
        lookup = candidate_session_lookup(state)

        state =
          Enum.reduce(sessions, state, fn session, state_acc ->
            adopt_known_orphan_session(state_acc, lookup, session)
          end)

        listings_ok? = Enum.all?(state.felt_stores, &Map.has_key?(state.last_full_listings, &1))
        complete_adoption(state, listings_ok?)

      {:error, :unknown} ->
        Logger.warning("tmux session scan unavailable (unknown state); skipping boot adoption")
        state
    end
  end

  # Per-poll reconcile: find live tmux sessions that have no watcher and adopt
  # them. Sessions already covered by a running entry are left alone. `scan` is
  # the cycle's `Poller.list_shuttle_sessions/1` result; on an :unknown scan
  # there is nothing safe to reconcile — retry next poll.
  def reconcile_orphaned_sessions(%State{} = state, scan, listings_ok?) do
    state = adopt_app_sessions(state)

    case scan do
      {:ok, sessions} -> state |> adopt_unwatched(sessions) |> complete_adoption(listings_ok?)
      {:error, :unknown} -> state
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

  defp adopt_unwatched(%State{} = state, sessions) do
    running_sessions = Enum.map(state.running, fn {_, meta} -> meta.session end) |> MapSet.new()

    orphan_sessions = Enum.reject(sessions, &MapSet.member?(running_sessions, &1))

    if orphan_sessions == [] do
      state
    else
      lookup = candidate_session_lookup(state)

      Enum.reduce(orphan_sessions, state, fn session, state_acc ->
        adopt_known_orphan_session(state_acc, lookup, session)
      end)
    end
  end

  # `session` is the *live* session to adopt. Callers that discovered a live
  # orphan pass its exact name; the default is the fiber's live worker session,
  # else its worker name, for callers that only have the fiber identity.
  def adopt_session(state, fiber_id, session \\ nil) do
    # Fetch first so the uid for the session name comes straight off the fiber.
    # The runtime maps key by the fiber's runtime key; felt I/O stays
    # slug-addressed.
    case Poller.fetch_fiber_full(fiber_id, state) do
      {:ok, fiber} ->
        uid = Map.get(fiber, "uid")

        session =
          session || Poller.live_session_for_fiber(state, fiber_id, uid) ||
            Dispatcher.session_name(fiber_id, uid)

        cond do
          # No uid, so no worker name and nothing to adopt under one.
          session == nil ->
            Logger.debug("Skipping adoption for #{fiber_id}: the fiber has no intrinsic id")
            state

          Map.get(fiber, "status") != "closed" or Shuttle.AppWorkers.app?(session) ->
            adopt_live_session(state, fiber_id, fiber, uid, session)

          true ->
            kill_closed_session(state, fiber_id, fiber, session)
        end

      {:error, _} ->
        # Fiber not found — skip, don't kill (could be from another host or test)
        Logger.debug("Skipping orphan session for unknown fiber: #{inspect(session)}")
        state
    end
  end

  defp adopt_live_session(state, fiber_id, fiber, uid, session) do
    # Label only — Shuttle owns resolution; read its resolved id off the
    # already-fetched fiber JSON rather than re-resolving.
    agent_id = Poller.agent_id_from_fiber(fiber)

    now = DateTime.utc_now()
    runtime_key = Poller.runtime_key_for_fiber(fiber)

    app_record =
      case Shuttle.AppWorkers.id(session) do
        nil ->
          %{}

        id ->
          case Shuttle.AppWorkers.get(id) do
            {:ok, record} -> record
            _ -> %{}
          end
      end

    # A re-adopted worker keeps the start it already had: the app record's,
    # else the fiber's durable dispatch stamp; `now` only when neither exists.
    started_at =
      [app_record["started_at"], get_in(fiber, ["shuttle", "runtime", "dispatched_at"])]
      |> Enum.find_value(now, fn
        stamp when is_binary(stamp) ->
          case DateTime.from_iso8601(stamp) do
            {:ok, timestamp, _} -> timestamp
            _ -> nil
          end

        _ ->
          nil
      end)

    running_meta = %{
      state: Map.get(app_record, "launch_state", "running"),
      launch_error: app_record["last_error"],
      fiber_id: fiber_id,
      session: session,
      agent_id: app_record["agent_id"] || agent_id,
      role: get_in(fiber, ["shuttle", "role"]),
      uid: uid,
      felt_store:
        if(Shuttle.AppWorkers.app?(session),
          do: app_record["felt_store"],
          else: Poller.owning_store(fiber_id, state)
        ),
      started_at: started_at,
      last_activity_at: started_at
    }

    case Shuttle.WorkerBackend.retire_assignment(state.runner, session, fiber) do
      :retired ->
        cond do
          fiber["status"] == "closed" ->
            Poller.stamp_handoff_if_stale(state, fiber_id, fiber)

          get_in(fiber, ["shuttle", "kind"]) == "standing" ->
            Shuttle.Poller.StandingRoles.mark_standing_awaiting(fiber_id)

          true ->
            :ok
        end

        state

      :retained ->
        # Restore the owned receiver only for an assignment we still supervise.
        running_meta = Poller.recover_context_receiver(state, running_meta, fiber)
        watch_adopted_session(state, fiber_id, fiber, runtime_key, running_meta)
    end
  end

  defp watch_adopted_session(state, fiber_id, fiber, runtime_key, running_meta) do
    session = running_meta.session

    case Poller.start_watcher(state, fiber_id, running_meta) do
      {:ok, running_meta} ->
        Logger.info("Adopted orphan session: #{session}")

        Poller.put_running(state, runtime_key, running_meta)
        |> Poller.note_running(runtime_key)
        |> Poller.acquire_worker_identity(fiber_id, fiber)

      {:error, reason} ->
        Logger.warning("Failed to adopt session #{session}: #{inspect(reason)}")
        state
    end
  end

  defp adopt_app_sessions(state) do
    Enum.reduce(Shuttle.AppWorkers.active(), state, fn record, acc ->
      fiber_id = record["fiber_id"]

      cond do
        not is_binary(fiber_id) or record["felt_store"] not in state.felt_stores ->
          acc

        app_session_tracked?(acc, fiber_id, record["session_uuid"]) ->
          restore_terminal_viewer(record, acc.runner)
          acc

        Poller.running_key(acc, fiber_id) != nil ->
          acc

        true ->
          fetched =
            case Poller.fetch_fiber_full(fiber_id, acc) do
              {:ok, _} = found -> found
              _ -> Poller.fetch_fiber_full(record["uid"] || fiber_id, acc)
            end

          case fetched do
            {:ok, fiber} ->
              if Poller.host_owned?(fiber["shuttle"] || %{}, acc.own_host_id) and
                   Shuttle.AppWorkers.same_fiber?(record, fiber["id"], fiber["uid"]) do
                state =
                  adopt_session(
                    acc,
                    fiber["id"],
                    Shuttle.AppWorkers.ref(record["session_uuid"])
                  )

                restore_terminal_viewer(record, acc.runner)
                state
              else
                acc
              end

            _ ->
              acc
          end
      end
    end)
  end

  defp app_session_tracked?(state, fiber_id, session_uuid) do
    case Poller.running_key(state, fiber_id) do
      nil ->
        false

      key ->
        get_in(state.running, [key, :session]) == Shuttle.AppWorkers.ref(session_uuid)
    end
  end

  # The App Server owns the conversation across daemon restarts, but a terminal
  # viewer belongs to its terminal backend and may have died with its server.
  # Check every poll: the backend can still be starting during boot adoption. Recreate only the
  # viewer for CLI-surface records; prepare verifies the exact stored thread and
  # starts its TUI without creating a model turn. App-surface records need none.
  defp restore_terminal_viewer(%{"surface" => "cli", "session_uuid" => id} = record, runner)
       when is_binary(id) do
    tmux = record["terminal_tmux"] || Shuttle.CodexTerminal.tmux_name(id)
    callers = Shuttle.Env.callers()

    case Task.Supervisor.start_child(Shuttle.TaskSupervisor, fn ->
           Shuttle.Env.adopt_callers(callers)
           lock = {{__MODULE__, {:restore_terminal_viewer, id}}, self()}

           case :global.trans(
                  lock,
                  fn ->
                    case Shuttle.Terminal.status(runner, tmux) do
                      :gone -> Shuttle.CodexTerminal.prepare(id, runner: runner)
                      :alive -> :ok
                      :unknown -> Shuttle.CodexTerminal.prepare(id, runner: runner)
                    end
                  end,
                  [node()],
                  0
                ) do
             {:ok, _} ->
               :ok

             :ok ->
               :ok

             {:error, reason} ->
               Logger.warning("Failed to restore Codex terminal for #{id}: #{inspect(reason)}")

             :aborted ->
               :ok

             other ->
               Logger.warning(
                 "Unexpected Codex terminal restoration result for #{id}: #{inspect(other)}"
               )
           end
         end) do
      {:ok, _pid} ->
        :ok

      {:error, reason} ->
        Logger.warning(
          "Could not schedule Codex terminal restoration for #{id}: #{inspect(reason)}"
        )
    end
  end

  defp restore_terminal_viewer(_record, _runner), do: :ok

  # Maps each candidate's worker session name (`<leaf>-<uid>-shuttle`) back to
  # its fiber, so orphan adoption recognizes the workers it launched. A uid is
  # unique to one fiber, so a name claimed by two fibers means a duplicated id
  # (a copied file): it resolves to `:ambiguous` and is skipped rather than
  # mis-adopted. A candidate without a uid has no worker name and no entry.
  defp candidate_session_lookup(%State{} = state) do
    state.last_known_listings
    |> Map.values()
    |> List.flatten()
    |> Enum.reduce(%{}, fn fiber, acc ->
      fiber_id = Map.get(fiber, "id")

      session =
        if is_binary(fiber_id) and fiber_id != "",
          do: Dispatcher.session_name(fiber_id, Map.get(fiber, "uid"))

      if session do
        bucket = if(Map.get(fiber, "status") == "closed", do: :closed, else: :open)

        # Record fiber_id in `bucket` of the session's grouped sets. `Map.update/4`
        # inserts the default VERBATIM when the key is absent — the function is NOT
        # applied to it — so the default must already carry fiber_id. Without this,
        # a session name seen exactly once (every name is unique to one fiber) keeps
        # empty sets, resolves to nil below, and the live worker is never adopted —
        # the daemon-restart-drops-all-adoptions bug.
        add_to_bucket = fn grouped ->
          Map.update!(grouped, bucket, &MapSet.put(&1, fiber_id))
        end

        singleton = add_to_bucket.(%{open: MapSet.new(), closed: MapSet.new()})
        Map.update(acc, session, singleton, add_to_bucket)
      else
        acc
      end
    end)
    |> Enum.into(%{}, fn {session, grouped} ->
      open_ids = Map.get(grouped, :open, MapSet.new()) |> MapSet.to_list()
      closed_ids = Map.get(grouped, :closed, MapSet.new()) |> MapSet.to_list()

      value =
        cond do
          length(open_ids) == 1 -> {:adopt, hd(open_ids)}
          length(open_ids) > 1 -> :ambiguous
          length(closed_ids) == 1 -> {:kill_closed, hd(closed_ids)}
          length(closed_ids) > 1 -> :ambiguous
          true -> nil
        end

      {session, value}
    end)
    |> Enum.reject(fn {_session, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp adopt_known_orphan_session(%State{} = state, lookup, session) do
    case Map.get(lookup, session) do
      {:adopt, fiber_id} ->
        if Poller.running_key(state, fiber_id) != nil do
          state
        else
          adopt_session(state, fiber_id, session)
        end

      {:kill_closed, fiber_id} ->
        fiber =
          case Poller.fetch_fiber_full(fiber_id, state) do
            {:ok, fiber} -> fiber
            {:error, _} -> nil
          end

        kill_closed_session(state, fiber_id, fiber, session)

      :ambiguous ->
        Logger.warning(
          "Skipping orphan session whose name two fibers share (a duplicated id): #{session}"
        )

        state

      nil ->
        Logger.debug("Skipping orphan session with no matching fiber: #{session}")
        state
    end
  end

  # A live session whose fiber is closed: the worker's deliberate exit (closed
  # implies handoff), so stamp the clean-exit marker (when the fiber could be
  # read) before killing the stale session.
  defp kill_closed_session(%State{} = state, fiber_id, fiber, session) do
    if fiber, do: Poller.stamp_handoff_if_stale(state, fiber_id, fiber)
    Logger.info("Killing stale session for closed fiber: #{fiber_id} session=#{session}")
    _ = Shuttle.Terminal.close(state.runner, session)
    state
  end
end
