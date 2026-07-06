defmodule Shuttle.RemoteFiberRegistry do
  @moduledoc """
  Polls each configured remote Shuttle daemon's owner-only kanban feed
  (`GET /api/v1/fibers?shuttle=true`), caches the latest feed per origin, and
  exposes it to the local daemon's composite board endpoint.

  This is the fiber-feed sibling of `Shuttle.RemoteRegistry`. Both consume the
  same `:remotes` config and the same HTTP-transport behaviour
  (`Shuttle.RemoteRegistry.Client`), but they own deliberately separate
  concerns:

    * **`RemoteRegistry`** polls `/state` as a fast health probe and drives the
      self-healing recovery cascade (tunnel bounce / SSH check / restart). Its
      loop must stay responsive.

    * **`RemoteFiberRegistry`** (this module) polls the heavier `/fibers` feed
      purely for the cross-host kanban board. A fibers-fetch failure here must
      NOT perturb recovery — it only marks the origin's feed stale.

  Keeping them apart matters for two reasons: a slow or failing fiber feed never
  triggers a tunnel bounce, and the two endpoints have different latency
  profiles (cineca's `/state` answers in milliseconds, but its `/fibers` is
  genuinely ~7-8s). Because a healthy feed fetch can take seconds, the fetch
  runs in a supervised `Task` (`async_nolink`) rather than inline in the
  GenServer loop — otherwise a single slow origin would queue every `feeds/0`
  read behind it.

  ## Composition

  The local daemon's `GET /api/v1/fibers/composite` concatenates this registry's
  cached remote feeds with the local owner feed (from
  `Shuttle.Poller.cached_fiber_documents/0`). Each feed row is the same
  owner-served entry shape (`felt_store` / `path` / `fiber` / `runtime`), so the
  composite is a flat per-fiber list with reconciled liveness: each host stamps
  its own workers' tmux liveness at serve time, so there is exactly one observer
  per fiber and no cross-observer disagreement to produce a column bounce.

  ## Test injection

  Like `RemoteRegistry`, the HTTP transport is the `Shuttle.RemoteRegistry.Client`
  behaviour so tests substitute a deterministic stub. Tests start the registry
  with `auto_poll: false` and drive it synchronously with `refresh_now/1`, which
  fetches inline (no `Task`) so the stub's response is observable on return.
  """

  use GenServer
  require Logger

  alias Shuttle.RegistryCommon
  alias Shuttle.Remote

  @default_tick_interval_ms 1_000
  @default_request_timeout_ms 20_000

  defmodule State do
    @moduledoc false
    defstruct [
      :remotes,
      :client,
      :task_supervisor,
      :tick_timer_ref,
      :tick_interval_ms,
      :request_timeout_ms,
      feeds: %{},
      # ref => remote name, for the in-flight fetch guard
      tasks: %{}
    ]
  end

  # ── Client ──

  @doc """
  Starts the registry. Accepts:

    * `:remotes` — list of `%Shuttle.Remote{}` (or maps/keyword lists). Defaults
      to `Application.get_env(:shuttle, :remotes, [])`.
    * `:client` — module implementing `Shuttle.RemoteRegistry.Client`. Defaults
      to `Shuttle.RemoteRegistry.Client.Default`.
    * `:task_supervisor` — `Task.Supervisor` name for the async fetches.
      Defaults to `Shuttle.TaskSupervisor`.
    * `:tick_interval_ms` — registry tick cadence. Defaults to 1_000.
    * `:request_timeout_ms` — per-fetch HTTP timeout. Defaults to 20_000
      (cineca's healthy `/fibers` latency is ~7-8s).
    * `:auto_poll` — schedule the background tick. Defaults to `true`; tests set
      `false` and drive deterministically with `refresh_now/1`.
    * `:name` — GenServer name. Defaults to `__MODULE__`.
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  Returns the cached feed map keyed by remote name. Each value carries
  `:fibers` (the list of owner-served entry maps), `:last_polled_at`, `:stale`,
  and `:last_error`.

  An empty map means no remotes are configured (or the registry isn't running —
  callers tolerate this for graceful degradation).
  """
  @spec feeds() :: %{String.t() => map()}
  def feeds, do: feeds(__MODULE__)

  @spec feeds(GenServer.server()) :: %{String.t() => map()}
  def feeds(server), do: feeds(server, RegistryCommon.read_timeout_ms())

  @spec feeds(GenServer.server(), non_neg_integer()) :: %{String.t() => map()}
  def feeds(server, timeout_ms) when is_integer(timeout_ms) and timeout_ms >= 0 do
    if RegistryCommon.registry_alive?(server) do
      GenServer.call(server, :feeds, timeout_ms)
    else
      %{}
    end
  end

  @doc """
  Synchronously fetches every remote's feed once and returns when all have been
  handled. Inline fetch (no `Task`) — used by tests to drive the registry
  deterministically against a stub client.
  """
  @spec refresh_now() :: :ok
  def refresh_now, do: refresh_now(__MODULE__)

  @spec refresh_now(GenServer.server()) :: :ok
  def refresh_now(server),
    do: GenServer.call(server, :refresh_now, RegistryCommon.read_timeout_ms())

  @doc """
  Synchronously refreshes one remote's owner feed.

  Write endpoints use this after a forwarded remote mutation so the local
  composite board's trailing refetch sees owner truth immediately instead of the
  previous scheduled-poll snapshot.
  """
  @spec refresh(String.t()) :: :ok | {:error, term()}
  def refresh(name), do: refresh(__MODULE__, name)

  @spec refresh(GenServer.server(), String.t()) :: :ok | {:error, term()}
  def refresh(server, name) when is_binary(name) do
    if RegistryCommon.registry_alive?(server) do
      GenServer.call(server, {:refresh, name}, RegistryCommon.read_timeout_ms())
    else
      {:error, :not_running}
    end
  end

  # ── Server ──

  @impl true
  def init(opts) do
    remotes =
      opts
      |> Keyword.get(:remotes, Application.get_env(:shuttle, :remotes, []))
      |> RegistryCommon.normalize_remotes()

    state = %State{
      remotes: remotes,
      client: Keyword.get(opts, :client, Shuttle.RemoteRegistry.Client.Default),
      task_supervisor: Keyword.get(opts, :task_supervisor, Shuttle.TaskSupervisor),
      tick_interval_ms: Keyword.get(opts, :tick_interval_ms, @default_tick_interval_ms),
      request_timeout_ms: Keyword.get(opts, :request_timeout_ms, @default_request_timeout_ms),
      feeds: Map.new(remotes, fn remote -> {remote.name, initial_entry(remote)} end)
    }

    auto_poll = Keyword.get(opts, :auto_poll, true)

    Logger.info(
      "RemoteFiberRegistry: configured #{length(remotes)} remote(s): " <>
        inspect(Enum.map(remotes, & &1.name))
    )

    state =
      if remotes == [] or not auto_poll do
        state
      else
        RegistryCommon.schedule_tick(state, 0)
      end

    {:ok, state}
  end

  @impl true
  def handle_call(:feeds, _from, state) do
    {:reply, build_feeds_view(state), state}
  end

  def handle_call(:refresh_now, _from, state) do
    now = DateTime.utc_now()

    feeds =
      Enum.reduce(state.remotes, state.feeds, fn remote, acc ->
        result = fetch_fibers(remote, state.client, state.request_timeout_ms)
        entry = Map.get(acc, remote.name, initial_entry(remote))
        Map.put(acc, remote.name, apply_result(entry, result, now))
      end)

    {:reply, :ok, %{state | feeds: feeds}}
  end

  def handle_call({:refresh, name}, _from, state) do
    case Enum.find(state.remotes, &(&1.name == name)) do
      %Remote{} = remote ->
        now = DateTime.utc_now()
        result = fetch_fibers(remote, state.client, state.request_timeout_ms)
        entry = Map.get(state.feeds, remote.name, initial_entry(remote))
        feeds = Map.put(state.feeds, remote.name, apply_result(entry, result, now))
        {:reply, :ok, %{state | feeds: feeds}}

      nil ->
        {:reply, {:error, :not_configured}, state}
    end
  end

  @impl true
  def handle_info({:tick, _token}, state) do
    state = start_due_fetches(state)
    state = RegistryCommon.schedule_tick(state, state.tick_interval_ms)
    {:noreply, state}
  end

  # A fetch Task completed normally. Demonitor+flush drops the trailing :DOWN.
  def handle_info({ref, {name, result}}, state) when is_reference(ref) do
    Process.demonitor(ref, [:flush])
    {:noreply, record_task_result(state, ref, name, result)}
  end

  # A fetch Task crashed before sending a result (the Default client rescues, so
  # this is rare). Record the failure (without flipping the badge) and clear the
  # in-flight guard.
  def handle_info({:DOWN, ref, :process, _pid, reason}, state) when is_reference(ref) do
    case Map.pop(state.tasks, ref) do
      {nil, _tasks} ->
        {:noreply, state}

      {name, tasks} ->
        Logger.warning("RemoteFiberRegistry: #{name} fiber fetch crashed: #{inspect(reason)}")
        feeds = record_failure(state.feeds, name, reason, DateTime.utc_now())
        {:noreply, %{state | tasks: tasks, feeds: feeds}}
    end
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # ── Fetch orchestration ──

  defp start_due_fetches(%State{} = state) do
    now_ms = DateTime.to_unix(DateTime.utc_now(), :millisecond)
    in_flight = MapSet.new(Map.values(state.tasks))

    Enum.reduce(state.remotes, state, fn remote, acc ->
      entry = Map.get(acc.feeds, remote.name, initial_entry(remote))

      if MapSet.member?(in_flight, remote.name) or not due?(entry, remote, now_ms) do
        acc
      else
        start_fetch(acc, remote)
      end
    end)
  end

  # Gate the next attempt on `last_attempt_at` (not `last_polled_at`) so a
  # permanently-slow origin retries at its configured cadence rather than every
  # tick.
  defp due?(%{last_attempt_at: %DateTime{} = last}, %Remote{} = remote, now_ms) do
    now_ms - DateTime.to_unix(last, :millisecond) >= remote.poll_interval_ms
  end

  defp due?(_entry, _remote, _now_ms), do: true

  defp start_fetch(%State{} = state, %Remote{} = remote) do
    client = state.client
    timeout = state.request_timeout_ms
    name = remote.name

    task =
      Task.Supervisor.async_nolink(state.task_supervisor, fn ->
        {name, fetch_fibers(remote, client, timeout)}
      end)

    feeds = stamp_attempt(state.feeds, remote)
    %{state | tasks: Map.put(state.tasks, task.ref, name), feeds: feeds}
  end

  defp record_task_result(%State{} = state, ref, name, result) do
    case Map.pop(state.tasks, ref) do
      {nil, _tasks} ->
        state

      {_name, tasks} ->
        entry = Map.get(state.feeds, name, initial_entry_for(state, name))
        feeds = Map.put(state.feeds, name, apply_result(entry, result, DateTime.utc_now()))
        %{state | tasks: tasks, feeds: feeds}
    end
  end

  defp fetch_fibers(%Remote{} = remote, client, timeout_ms) do
    url = Remote.fibers_url(remote)

    case client.get(url, timeout_ms) do
      {:ok, body} ->
        case Jason.decode(body) do
          {:ok, %{"fibers" => fibers}} when is_list(fibers) -> {:ok, fibers}
          # Well-formed envelope without a fibers list (e.g. an error envelope):
          # treat as zero owned fibers rather than a transport failure.
          {:ok, %{}} -> {:ok, []}
          _ -> {:error, :malformed_json}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  # ── Feed entries ──

  defp initial_entry(%Remote{} = remote) do
    %{
      fibers: [],
      last_polled_at: nil,
      last_attempt_at: nil,
      last_error: nil,
      remote: remote
    }
  end

  defp initial_entry_for(%State{remotes: remotes}, name) do
    case Enum.find(remotes, &(&1.name == name)) do
      %Remote{} = remote -> initial_entry(remote)
      _ -> %{fibers: [], last_polled_at: nil, last_attempt_at: nil, last_error: nil}
    end
  end

  defp stamp_attempt(feeds, %Remote{name: name} = remote) do
    entry = Map.get(feeds, name, initial_entry(remote))
    Map.put(feeds, name, %{entry | last_attempt_at: DateTime.utc_now()})
  end

  defp apply_result(entry, {:ok, fibers}, now) do
    %{
      entry
      | fibers: fibers,
        last_polled_at: now,
        last_attempt_at: now,
        last_error: nil
    }
  end

  defp apply_result(entry, {:error, reason}, now) do
    Logger.debug("RemoteFiberRegistry: fiber fetch failed: #{inspect(reason)}")
    # A failed poll records THAT it failed but does not itself declare the feed
    # stale: last-good `fibers` and the last-success `last_polled_at` are left
    # untouched, so a single blip only lets time accrue toward the grace window.
    # Staleness is decided purely by `stale?/2` (time since last success) — a
    # genuine outage crosses stale_multiplier × poll_interval; one 8s-timeout
    # does not.
    %{entry | last_attempt_at: now, last_error: reason}
  end

  # The `:DOWN` crash path (rare — the Default client rescues). Same contract as
  # a failed fetch: record the failure without touching last-good state or the
  # last-success timestamp; time alone drives the badge.
  defp record_failure(feeds, name, reason, now) do
    case Map.get(feeds, name) do
      nil ->
        feeds

      entry ->
        Map.put(feeds, name, %{entry | last_attempt_at: now, last_error: reason})
    end
  end

  # ── Views ──

  defp build_feeds_view(%State{} = state) do
    now = DateTime.utc_now()

    Map.new(state.feeds, fn {name, entry} ->
      {name,
       %{
         fibers: entry.fibers,
         last_polled_at: entry.last_polled_at,
         stale: stale?(entry, now),
         last_error: entry.last_error
       }}
    end)
  end

  # Staleness is purely "no successful poll within the grace window": a feed is
  # stale iff its last SUCCESS (`last_polled_at`) is older than
  # stale_multiplier × poll_interval (a `nil` last-success is always stale). A
  # failed fetch never sets a flag — it only withholds a fresh `last_polled_at`,
  # letting time accrue. This is the hysteresis: a success flips `stale?` to
  # false INSTANTLY (fast recovery), while a failure only slowly ages toward the
  # alarm.
  defp stale?(%{remote: %Remote{} = remote, last_polled_at: last}, now) do
    Remote.stale?(remote, last, now)
  end

  # No `remote` to time-check against (the initial_entry_for nil-remote
  # fallback): an unknown/unconfigured remote can't be time-checked, so treat as
  # stale.
  defp stale?(_entry, _now), do: true
end
