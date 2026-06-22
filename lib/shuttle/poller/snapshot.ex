defmodule Shuttle.Poller.Snapshot do
  @moduledoc """
  Read-only serialization of `Shuttle.Poller` state into the wire shapes the
  `:4000` API and the kanban feed consume.

  Every function here is a pure projection: it takes the poller `State` (or a
  slice of it) and returns plain maps/lists. The wire shape is load-bearing —
  API and kanban consumers depend on it byte-for-byte — so changes here must
  preserve it exactly.

  State-coupled helpers that the rest of the poller also relies on
  (`fiber_address/1`, `metadata_uid/1`, `runtime_seconds/2`) stay in
  `Shuttle.Poller` as the single source of truth and are called back into from
  here. `standing_role_snapshots/4` lives in `Shuttle.Poller.StandingRoles`.
  """

  alias Shuttle.Poller
  alias Shuttle.Poller.StandingRoles
  alias Shuttle.Poller.State

  @spec build_snapshot(State.t()) :: map()
  def build_snapshot(state) do
    now = DateTime.utc_now()
    now_ms = DateTime.to_unix(now, :millisecond)

    eligible =
      Enum.map(state.running, fn {_runtime_key, meta} ->
        fiber_id = Poller.fiber_address(meta)

        %{
          fiber_id: fiber_id,
          uid: Poller.metadata_uid(meta),
          felt_store: Map.get(state.fiber_host_cache, fiber_id),
          tmux_session: meta.session,
          agent: meta.agent_id,
          state: Map.get(meta, :state, "running"),
          run_id: Map.get(meta, :run_id),
          started_at: DateTime.to_unix(meta.started_at, :millisecond),
          last_activity_at: DateTime.to_unix(meta.last_activity_at, :millisecond),
          runtime_seconds: Poller.runtime_seconds(meta.started_at, now)
        }
      end)

    dispatch_blocked =
      Enum.map(state.dispatch_failures, fn {_runtime_key, entry} ->
        %{
          # `dispatch_failures` is keyed by runtime key (uid); the entry carries
          # the slug + uid so the row exposes both, unchanged in wire shape.
          fiber_id: entry.fiber_id,
          uid: Map.get(entry, :uid),
          reason: format_block_reason(entry.reason),
          attempts: entry.attempts,
          attempted_at: DateTime.to_unix(entry.attempted_at, :millisecond),
          first_attempted_at: DateTime.to_unix(entry.first_attempted_at, :millisecond)
        }
      end)

    # Open resume-loop breakers surface as blocked rows too, so the board shows a
    # fiber paused by the breaker (and why) instead of it silently going idle.
    loop_blocked =
      state.resume_loop
      |> Map.values()
      |> Enum.filter(&match?(%DateTime{}, &1.opened_at))
      |> Enum.map(fn entry ->
        %{
          fiber_id: entry.fiber_id,
          uid: Map.get(entry, :uid),
          reason: "resume_loop (#{entry.count} rapid exits)",
          attempts: entry.count,
          attempted_at: DateTime.to_unix(entry.opened_at, :millisecond),
          first_attempted_at: DateTime.to_unix(entry.opened_at, :millisecond)
        }
      end)

    blocked = dispatch_blocked ++ loop_blocked

    snap = %{
      poll_at: now_ms,
      # Reflect the dispatch-filter identity, not just :inet.gethostname().
      # When SHUTTLE_HOST is set this matches the host operators read in logs
      # and use to author `shuttle.host:` pins on fibers.
      host: state.own_host_id,
      felt_stores: state.felt_stores,
      eligible: eligible,
      blocked: blocked,
      orphans: state.orphans,
      # Retries collapsed into the poll loop: a status:active fiber with
      # no live tmux session is simply eligible again on the next tick. The key
      # stays (empty) for snapshot-shape stability with API/kanban consumers.
      retrying: [],
      standing_roles:
        StandingRoles.standing_role_snapshots(state.standing_roles, state.running, now, state),
      claimed_count: MapSet.size(state.claimed),
      max_concurrent: state.max_concurrent_workers,
      document_cache: stringify_keys(state.document_cache_stats)
    }

    # No separate per-fiber runtime index. The runtime store and the
    # review overlay it fed are gone; liveness rides the `eligible`/`running`
    # rows (each carries uid, tmux_session, state), standing-role due-ness rides
    # `standing_roles`, and a viewer computes next_due from the document
    # `schedule` it already reads off the owner-only feed. There is nothing left
    # for a `:runtime` overlay to add.
    snap
  end

  @spec build_full_state(State.t()) :: map()
  def build_full_state(state) do
    snap = build_snapshot(state)

    running_detail =
      Enum.map(state.running, fn {runtime_key, meta} ->
        fiber_id = Poller.fiber_address(meta)

        %{
          runtime_key: runtime_key,
          fiber_id: fiber_id,
          pid: inspect(meta.pid),
          session: meta.session,
          agent_id: meta.agent_id,
          started_at: DateTime.to_unix(meta.started_at, :millisecond),
          last_activity_at: DateTime.to_unix(meta.last_activity_at, :millisecond)
        }
      end)

    reservations =
      Enum.map(state.reservations, fn {{resource, host}, res} ->
        %{
          resource: resource,
          host: host,
          fiber_id: res.fiber_id,
          expires_in_ms: max(0, res.expires_at_ms - System.monotonic_time(:millisecond))
        }
      end)

    Map.merge(snap, %{
      running_detail: running_detail,
      reservations: reservations,
      # No waiters: the Channel transport (the only producer) was removed; the
      # key stays for payload-shape stability and is always empty.
      waiters: []
    })
  end

  @doc """
  Builds the `runtime_key | uid | fiber_id => payload` index for the running
  workers, keyed under every identifier a feed entry might carry so a uid-less
  fiber still matches.
  """
  def runtime_index(running, activity) do
    Enum.reduce(running, %{}, fn {runtime_key, meta}, acc ->
      payload = runtime_payload(meta, activity)

      [runtime_key, Poller.metadata_uid(meta), Poller.fiber_address(meta)]
      |> Enum.filter(&(is_binary(&1) and &1 != ""))
      |> Enum.reduce(acc, fn key, a -> Map.put_new(a, key, payload) end)
    end)
  end

  @doc """
  Stamps a feed entry with its `:runtime` payload if the runtime index has a
  match under the fiber's uid/slug/id; otherwise returns the entry unchanged.
  """
  def put_runtime(%{fiber: fiber} = entry, index) do
    [Map.get(fiber, "uid"), Map.get(fiber, "slug"), Map.get(fiber, "id")]
    |> Enum.find_value(fn k -> is_binary(k) and k != "" and Map.get(index, k) end)
    |> case do
      nil -> entry
      payload -> Map.put(entry, :runtime, payload)
    end
  end

  # The eligible-row subset of a worker's meta, as a wire payload. Mirrors the
  # `eligible` snapshot row so the feed's `runtime` and the snapshot agree on
  # shape; the viewer reads `tmux_session` for liveness and may surface the rest.
  #
  # `last_activity_at` + `phase` come from the activity tracker keyed by this
  # worker's tmux session: the REAL timestamp of its most recent hook event and
  # the event's phase category ("attention" / "waiting" / "working"). This is
  # what lets the in-flight column rank by idle duration. The old served
  # `last_activity_at` was `meta.last_activity_at`, which equals `started_at`
  # (only the tmux liveness heartbeat ever bumps it) — useless for ranking.
  #
  # Fallback: a just-dispatched worker with no hook event yet has no tracker
  # record, so we fall back to `meta.last_activity_at` (≈ `started_at`) and omit
  # `phase` — correct, since a brand-new worker shouldn't outrank an idle review.
  defp runtime_payload(meta, activity) do
    base = %{
      tmux_session: meta.session,
      agent: Map.get(meta, :agent_id),
      state: Map.get(meta, :state, "running"),
      run_id: Map.get(meta, :run_id),
      started_at: DateTime.to_unix(meta.started_at, :millisecond)
    }

    case is_binary(meta.session) and Map.get(activity, meta.session) do
      %{last_event_at: at, phase: phase} ->
        base |> Map.put(:last_activity_at, at) |> Map.put(:phase, phase)

      _ ->
        Map.put(base, :last_activity_at, DateTime.to_unix(meta.last_activity_at, :millisecond))
    end
  end

  defp stringify_keys(value) when is_map(value) do
    Map.new(value, fn {key, value} -> {to_string(key), value} end)
  end

  defp stringify_keys(_), do: %{}

  # Stringifies dispatch-failure reasons for the snapshot. Atoms become their
  # name (':missing_session_id' is more useful in the UI than the raw atom);
  # strings pass through; everything else falls back to inspect/1.
  defp format_block_reason(reason) when is_atom(reason), do: Atom.to_string(reason)
  defp format_block_reason(reason) when is_binary(reason), do: reason
  defp format_block_reason(reason), do: inspect(reason)
end
