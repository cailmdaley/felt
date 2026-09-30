defmodule Shuttle.Poller.Snapshot do
  @moduledoc """
  Read-only serialization of `Shuttle.Poller` state into the wire shapes the
  `:4000` API and the kanban feed consume.

  Every function here is a pure projection: it takes the poller `State` (or a
  slice of it) and returns plain maps/lists. The wire shape is load-bearing —
  API and kanban consumers depend on it byte-for-byte — so changes here must
  preserve it exactly.

  The identity helpers it shares with the rest of the poller (`fiber_address/1`,
  `metadata_uid/1`) live in `Shuttle.Poller`; `standing_role_snapshots/3` lives
  in `Shuttle.Poller.StandingRoles`.
  """

  require Shuttle.Dispatcher

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

        meta
        |> worker_fields()
        |> Map.merge(%{
          fiber_id: fiber_id,
          uid: Poller.metadata_uid(meta),
          felt_store: Map.get(state.fiber_store_cache, fiber_id),
          last_activity_at: DateTime.to_unix(meta.last_activity_at, :millisecond),
          runtime_seconds: Poller.runtime_seconds(meta.started_at, now)
        })
        |> native_activity(meta.session)
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

    # Autonomous dispatches the boot quarantine (or a contract skew) is
    # withholding — all of them, resumes included. First-class rows, not
    # `blocked`: nothing failed — the daemon is deliberately withholding
    # autonomous dispatch authority until a human releases it (quarantine) or
    # fixes + restarts (skew). The kanban reads `boot_quarantine`/
    # `contract_skew` for its banner and these rows for the per-fiber
    # "parked" badge. Skew takes reason precedence when both are true — it's
    # the more actionable signal (quarantine self-explains via its own
    # release button; skew needs the CLI/daemon pair fixed first).
    pending_reason =
      if state.contract_check.ok,
        do: "boot quarantine — awaiting release",
        else: "contract skew — #{state.contract_check.reason}"

    pending_launch =
      Enum.map(state.parked_launches, fn {_runtime_key, entry} ->
        %{
          fiber_id: entry.fiber_id,
          uid: entry.uid,
          reason: pending_reason,
          parked_at: DateTime.to_unix(entry.parked_at, :millisecond)
        }
      end)

    %{
      poll_at: now_ms,
      # Reflect the dispatch-filter identity, not just :inet.gethostname().
      # When SHUTTLE_HOST is set this matches the host operators read in logs
      # and use to author `shuttle.host:` pins on fibers.
      host: state.own_host_id,
      # What this daemon IS, not just what it is doing. It rides the snapshot
      # so a hub's `/state/composite` answers "which host is on which build"
      # from the one fetch it already makes — the question every fleet deploy
      # ends on — without a `/version` round trip per host.
      build: Shuttle.BuildStamp.stamp(),
      felt_stores: state.felt_stores,
      eligible: eligible,
      blocked: blocked,
      boot_quarantine: state.boot_quarantine,
      # The boot-time `shuttle contract` handshake result — always
      # present (not just on skew) so /api/v1/state and /api/v1/version can
      # both show "what we expect" and "what we saw" even when they match.
      contract: Map.take(state.contract_check, [:expected, :observed, :ok, :reason]),
      pending_launch: pending_launch,
      orphans: state.orphans,
      standing_roles: StandingRoles.standing_role_snapshots(state.standing_roles, now, state),
      claimed_count: map_size(state.running),
      max_concurrent: state.max_concurrent_workers,
      # The refresh's hit/miss/eviction/entry counts plus the feed envelope's
      # freshness fields (its `entries` is the live cache size; the stats'
      # count from the last refresh is the one reported here).
      document_cache:
        state
        |> Poller.document_cache_meta()
        |> Map.delete(:entries)
        |> Map.merge(state.document_cache_stats)
        |> stringify_keys()
    }
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

    Map.put(snap, :running_detail, running_detail)
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
    fiber
    |> index_match(index)
    |> case do
      nil -> entry
      payload -> Map.put(entry, :runtime, put_session_link(payload, fiber))
    end
  end

  @doc """
  Builds the `fiber_id | uid => held payload` index for boot-quarantine-parked
  launches, keyed under every identifier a feed entry might carry (the same
  scheme as `runtime_index/2`) so the owning host's per-fiber feed can stamp
  `held` on a card without any board-side global-state lookup.
  """
  def parked_index(parked_launches) do
    Enum.reduce(parked_launches, %{}, fn {_runtime_key, entry}, acc ->
      payload = %{parked_at: DateTime.to_unix(entry.parked_at, :millisecond)}

      [entry.fiber_id, entry.uid]
      |> Enum.filter(&(is_binary(&1) and &1 != ""))
      |> Enum.reduce(acc, fn key, a -> Map.put_new(a, key, payload) end)
    end)
  end

  @doc """
  Stamps a feed entry with `held: true` (and its `held_since` timestamp) when the
  parked index has a match under the fiber's uid/slug/id; otherwise returns the
  entry unchanged. The card renders "held by boot quarantine" — distinct from the
  running `:runtime` overlay and from an idle-active card.
  """
  def put_held(%{fiber: fiber} = entry, index) do
    fiber
    |> index_match(index)
    |> case do
      nil -> entry
      %{parked_at: at} -> entry |> Map.put(:held, true) |> Map.put(:held_since, at)
    end
  end

  # Where a phone opens this worker: the claude.ai bridge URL of the session
  # named by the fiber's own `shuttle.runtime.session_uuid` (the transcript is
  # on this host — the owner stamps its own rows). Omitted when the session was
  # never bridged, so a viewer renders a stamp rather than a link to nowhere.
  defp put_session_link(payload, fiber) do
    case get_in(fiber, ["shuttle", "runtime", "session_uuid"]) do
      uuid when is_binary(uuid) and uuid != "" ->
        case Shuttle.SessionLink.cached_url(uuid) do
          url when is_binary(url) -> Map.put(payload, :session_link, url)
          nil -> payload
        end

      _ ->
        payload
    end
  end

  # The first index hit under any identifier a feed entry's fiber might carry.
  defp index_match(fiber, index) do
    [Map.get(fiber, "uid"), Map.get(fiber, "slug"), Map.get(fiber, "id")]
    |> Enum.find_value(fn k -> is_binary(k) and k != "" and Map.get(index, k) end)
  end

  # The worker fields the `eligible` snapshot row and the feed's `runtime`
  # payload share, so the two agree on shape. The payload's presence is the
  # viewer's liveness signal and `state` qualifies it; `tmux_session` is only
  # the CLI worker's terminal handle (nil for an app worker).
  defp worker_fields(meta) do
    app_id = Shuttle.AppWorkers.id(meta.session)

    %{
      tmux_session: Shuttle.WorkerBackend.tmux(meta.session),
      surface: if(app_id, do: "app", else: "cli"),
      session_uuid: app_id,
      thread_id: app_id,
      desktop_link: Shuttle.SessionLink.desktop_url(app_id),
      transcript_session_uuid: app_id && Shuttle.AppWorkers.transcript_id(app_id),
      agent: Map.get(meta, :agent_id),
      state: Map.get(meta, :state, "running"),
      launch_error: Map.get(meta, :launch_error),
      run_id: Map.get(meta, :run_id),
      started_at: DateTime.to_unix(meta.started_at, :millisecond)
    }
  end

  # The feed's `runtime` payload: the shared worker fields plus activity.
  #
  # `last_activity_at` + `phase` come from the activity tracker keyed by this
  # worker's tmux session: the REAL timestamp of its most recent hook event and
  # the event's phase category ("attention" / "waiting" / "working"). This is
  # what lets the in-flight column rank by idle duration; `meta.last_activity_at`
  # equals `started_at` (only the tmux liveness heartbeat ever bumps it), which
  # is useless for ranking.
  #
  # Fallback: a just-dispatched worker with no hook event yet has no tracker
  # record, so we fall back to `meta.last_activity_at` (≈ `started_at`) and omit
  # `phase` — correct, since a brand-new worker shouldn't outrank an idle review.
  defp runtime_payload(meta, activity) do
    base = worker_fields(meta)

    activity_key =
      case Shuttle.AppWorkers.id(meta.session) do
        nil -> meta.session
        id -> Shuttle.AppWorkers.transcript_id(id)
      end

    payload =
      case is_binary(activity_key) and Map.get(activity, activity_key) do
        %{last_event_at: at, phase: phase} ->
          base |> Map.put(:last_activity_at, at) |> Map.put(:phase, phase)

        _ ->
          Map.put(base, :last_activity_at, DateTime.to_unix(meta.last_activity_at, :millisecond))
      end

    native_activity(payload, meta.session)
  end

  defp native_activity(payload, session) do
    case Shuttle.AppWorkers.id(session) do
      nil ->
        payload

      id ->
        case Shuttle.AppWorkers.get(id) do
          {:ok, %{"launch_state" => "running", "remote_phase" => phase} = record}
          when phase in ["working", "waiting", "attention"] ->
            payload
            |> Map.put(:phase, phase)
            |> Map.put(:last_activity_at, record["phase_changed_at"] || payload.last_activity_at)

          _ ->
            Map.delete(payload, :phase)
        end
    end
  end

  defp stringify_keys(value) when is_map(value) do
    Map.new(value, fn {key, value} -> {to_string(key), value} end)
  end

  # Stringifies dispatch-failure reasons for the snapshot. Atoms become their
  # name (':missing_session_id' is more useful in the UI than the raw atom);
  # strings pass through; everything else falls back to inspect/1.

  # A dispatch preflight refusal carries its own operator-facing message — the
  # one thing a stranger needs on the board to fix their install. Show the
  # message, not the tuple.
  defp format_block_reason({tag, message}) when Shuttle.Dispatcher.refusal?(tag, message),
    do: message

  defp format_block_reason({:arm_refused, %{message: message}}),
    do: "start refused: #{message}"

  defp format_block_reason(reason) when is_atom(reason), do: Atom.to_string(reason)
  defp format_block_reason(reason) when is_binary(reason), do: reason
  defp format_block_reason(reason), do: inspect(reason)
end
