defmodule Shuttle.Poller.SessionReconciliation do
  @moduledoc """
  Orphan adoption / live-session reconciliation for the poller.

  When the daemon restarts, the `shuttle-<id>` tmux sessions it launched keep
  running untouched (tmux owns the worker process; Shuttle only owns the
  watcher). This module re-adopts those live sessions so the daemon resumes
  supervising them — at boot (`adopt_orphans/1`) and on every poll
  (`reconcile_orphaned_sessions/1`). Both walk the live `shuttle-*` tmux
  sessions, map each back to its fiber through `candidate_session_lookup/1`
  (which recognizes both the uid-keyed canonical name and the legacy leaf-only
  name, guarding ambiguous leaves), and either start a watcher over the live
  session, kill a session whose fiber has closed, or skip an unknown one.

  State-shaped helpers take the `Shuttle.Poller.State` struct and return updated
  state, mirroring the signatures they had inside `Shuttle.Poller`. Truly shared
  helpers stay in `Shuttle.Poller` and are called from here:
  `running_key/2`, `fiber_address/1`, `runtime_key_for_fiber/1`,
  `list_shuttle_sessions/1`, `discover_candidates/1`, `fetch_fiber_full/2`,
  `agent_id_from_fiber/1`, `start_watcher/3`, `live_session_for_fiber/3`.
  """

  require Logger

  alias Shuttle.Dispatcher
  alias Shuttle.Poller
  alias Shuttle.Poller.State

  # Re-adopt every live shuttle tmux session at boot. The daemon was down or
  # restarting; the workers kept running. Each live session is mapped back to its
  # fiber and re-watched (or killed if the fiber has since closed).
  def adopt_orphans(%State{} = state) do
    {:ok, sessions} = Poller.list_shuttle_sessions(state)
    lookup = candidate_session_lookup(state)

    Enum.reduce(sessions, state, fn session, state_acc ->
      adopt_known_orphan_session(state_acc, lookup, session)
    end)
  end

  # Per-poll reconcile: find live tmux sessions that have no watcher and adopt
  # them. Sessions already covered by a running entry are left alone.
  def reconcile_orphaned_sessions(%State{} = state) do
    # Find tmux sessions that exist but have no watcher.
    {:ok, sessions} = Poller.list_shuttle_sessions(state)
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

  # `session` is the *live* tmux session name to adopt. Callers that discovered
  # a live orphan pass its exact name (which may be the legacy leaf-only form on
  # a worker launched before the uid-keyed cutover); the default picks whichever
  # of the fiber's name forms is actually live (preferring the uid-keyed name),
  # for callers that only have the fiber identity.
  def adopt_session(state, fiber_id, session \\ nil) do
    # Fetch first so the uid for the canonical session name comes straight off
    # the fiber (the uid↔slug bridge and its cache are gone). The runtime maps
    # key by the fiber's runtime key; felt I/O stays slug-addressed.
    case Poller.fetch_fiber_full(fiber_id, state) do
      {:ok, fiber} ->
        uid = Map.get(fiber, "uid")

        session =
          session || Poller.live_session_for_fiber(state, fiber_id, uid) ||
            Dispatcher.session_name(fiber_id, uid)

        if Map.get(fiber, "status") != "closed" do
          # Label only — felt owns resolution; read its resolved id off the
          # already-fetched fiber JSON rather than re-resolving.
          agent_id = Poller.agent_id_from_fiber(fiber)

          now = DateTime.utc_now()
          runtime_key = Poller.runtime_key_for_fiber(fiber)

          running_meta = %{
            fiber_id: fiber_id,
            session: session,
            agent_id: agent_id,
            uid: uid,
            started_at: now,
            last_activity_at: now
          }

          case Poller.start_watcher(state, fiber_id, running_meta) do
            {:ok, running_meta} ->
              running = Map.put(state.running, runtime_key, running_meta)

              Logger.info("Adopted orphan session: #{session}")
              %{state | running: running, claimed: MapSet.put(state.claimed, runtime_key)}

            {:error, reason} ->
              Logger.warning("Failed to adopt session #{session}: #{inspect(reason)}")
              state
          end
        else
          # Fiber is closed but tmux session still exists — kill it
          Logger.info("Killing stale session for closed fiber: #{session}")
          _ = state.runner.cmd("tmux", ["kill-session", "-t", session], stderr_to_stdout: true)
          state
        end

      {:error, _} ->
        # Fiber not found — skip, don't kill (could be from another host or test)
        Logger.debug("Skipping orphan session for unknown fiber: #{inspect(session)}")
        state
    end
  end

  # Maps every live tmux session name a candidate could carry — both the
  # uid-keyed canonical name and the legacy leaf-only name — back to its fiber,
  # so orphan adoption recognizes a worker launched under either scheme. The
  # uid-keyed entries are inherently collision-free; the legacy leaf-only
  # entries keep the existing ambiguity guard (two fibers sharing a leaf resolve
  # to `:ambiguous` and are skipped rather than mis-adopted).
  def candidate_session_lookup(%State{} = state) do
    {:ok, candidates, _host_map} = Poller.discover_candidates(state)

    candidates
    |> Enum.reduce(%{}, fn fiber, acc ->
      case {Map.get(fiber, "id"), Map.get(fiber, "status")} do
        {fiber_id, status} when is_binary(fiber_id) and fiber_id != "" ->
          bucket = if(status == "closed", do: :closed, else: :open)

          # Record fiber_id in `bucket` of the session's grouped sets. `Map.update/4`
          # inserts the default VERBATIM when the key is absent — the function is NOT
          # applied to it — so the default must already carry fiber_id. Without this,
          # a session name seen exactly once (every uid-keyed name is unique to one
          # fiber) keeps empty sets, resolves to nil below, and the live worker is
          # never adopted — the daemon-restart-drops-all-adoptions bug.
          add_to_bucket = fn grouped -> Map.update!(grouped, bucket, &MapSet.put(&1, fiber_id)) end
          singleton = add_to_bucket.(%{open: MapSet.new(), closed: MapSet.new()})

          fiber_id
          |> Dispatcher.session_names(Map.get(fiber, "uid"))
          |> Enum.reduce(acc, fn session, acc2 ->
            Map.update(acc2, session, singleton, add_to_bucket)
          end)

        _ ->
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

  def adopt_known_orphan_session(%State{} = state, lookup, session) do
    case Map.get(lookup, session) do
      {:adopt, fiber_id} ->
        if Poller.running_key(state, fiber_id) != nil do
          state
        else
          adopt_session(state, fiber_id, session)
        end

      {:kill_closed, fiber_id} ->
        Logger.info("Killing stale session for closed fiber: #{fiber_id} session=#{session}")
        _ = state.runner.cmd("tmux", ["kill-session", "-t", session], stderr_to_stdout: true)
        state

      :ambiguous ->
        Logger.warning("Skipping orphan session with ambiguous leaf-only name: #{session}")
        state

      nil ->
        Logger.debug("Skipping orphan session with no matching fiber: #{session}")
        state
    end
  end
end
