defmodule Shuttle.RemoteTemporalRegistry do
  @moduledoc """
  Holds each configured remote Shuttle daemon's four **temporal** feeds —
  `/activity`, `/sessions`, `/commits`, `/sent-files/all` — fetching them on
  demand, and persists each to disk so the hub's memory of a remote survives
  both a disconnect and a daemon restart.

  This is the third registry, sibling to `Shuttle.RemoteRegistry` (liveness
  probe + recovery cascade) and `Shuttle.RemoteFiberRegistry` (the kanban
  feed). It shares their client behaviour, their conditional fetch and their
  "an error never clears data" rule, and differs from them in three ways:

    * **No background polling.** Nothing here drives recovery or a badge that
      must flip in seconds, and a fleet's worth of 14-day windows is real
      bandwidth. So nothing is fetched until a composite asks: `entries/2`
      names one feed, and only that feed is refreshed, only for the remotes
      whose last attempt at it is older than the freshness gate. A board
      nobody is looking at costs its remotes nothing.

    * **Per-feed state.** Each `{remote, feed}` pair carries its own items,
      etag, `last_polled_at`, `last_attempt_at` and `last_error`, and is
      fetched by its own supervised task. A slow `/activity` never holds up
      `/sessions`, and the `origins` block a composite serves describes the
      feed it served.

    * **Disk persistence.** Every 200 is written as JSON under
      `$SHUTTLE_DATA_DIR/remote-temporal/<feed>/<name>.json` and read back at
      init. The point of the feature is a temporal view that still shows a
      remote's last two weeks while that host is unreachable — memory that
      evaporates on a daemon bounce would not deliver that.

  ## A request's life

  A composite calls `entries(feed)`. For each remote whose attempt at `feed` is
  older than `@freshness_ms` and not already in flight, the registry starts a
  conditional GET (the stored etag as `If-None-Match`) in a task under
  `Shuttle.TaskSupervisor` — remotes in parallel. The caller is parked, not the
  GenServer: it is answered once every fetch it is waiting on has landed, or
  after `@wait_ms`, whichever comes first, with whatever the registry then
  holds. A fetch that outlives the wait keeps running and lands for the next
  request. Concurrent requests for the same feed share the one in-flight
  fetch; within the gate, requests are answered from memory at once.

  The gate is on the last ATTEMPT, not the last success, so an unreachable
  remote is retried at most once per gate however often the board asks.

  ## Staleness

  A feed is `stale` iff its last success is more than `@stale_after_ms` ago
  (or it has never succeeded). That bound is ten freshness gates — ten minutes
  — because it has to clear the consumer's own cadence (Chronicle refetches
  every five minutes) plus one fetch that outlived the wait: a remote that
  answered the previous request and is slow on this one has not gone stale.
  A failure never sets the flag on its own; it withholds a fresh timestamp and
  records `last_error`. Restored data inherits its persisted `last_polled_at`,
  so it ages from when it was actually fetched.

  ## The activity window

  Activity is fetched over a **trailing 14-day window** whose upper bound is
  now ceiled to a `@window_quantum_ms` (5-minute) boundary. The quantum is what
  lets the remote answer 304: its validator covers the window, and a window
  sliding with the wall clock would never match. Within a quantum the remote
  304s until its event stream moves; the window re-anchors at most once per
  quantum. The feed is refetched whole rather than merged incrementally — a
  full refetch is redundant only behind an `If-None-Match`, which is exactly
  where it happens. Sessions, commits and sent files ask for the whole ledger
  (`since_ms=0`); the composite applies the request's window.

  Each activity entry records the window it covers. A composite asking for a
  wider window is served what is held, and the covered window is reported back
  in the origins block, so the view marks the rest as unknown rather than
  quiet.

  ## Test injection

  The HTTP transport is the `Shuttle.RemoteRegistry.Client` behaviour.
  `refresh_now/1` fetches every feed of every remote inline, ignoring the gate,
  for tests that want the cache primed deterministically; `:freshness_ms` and
  `:wait_ms` shrink the gate and the wait for tests of the demand path.
  """

  use GenServer
  require Logger

  alias Shuttle.RegistryCommon
  alias Shuttle.Remote

  @default_request_timeout_ms 20_000

  # A feed attempted this recently is served from memory without a fetch.
  @freshness_ms 60_000

  # The longest a composite request waits for the fetches it triggered.
  @wait_ms 5_000

  # See the moduledoc's staleness note.
  @stale_after_gates 10

  # The trailing window activity is held over, and the boundary its upper
  # bound is ceiled to.
  @window_days 14
  @window_ms @window_days * 24 * 60 * 60 * 1_000
  @window_quantum_ms 5 * 60_000

  @feeds [:activity, :sessions, :commits, :sent_files]

  @typedoc "The feeds a composite can ask for."
  @type feed :: :activity | :sessions | :commits | :sent_files

  @typedoc """
  One remote's view of one feed, as `entries/2` returns it. `window` is the
  covered `{from_ms, to_ms}` for activity and `nil` for every other feed (and
  for activity before its first success). `etag` is the remote's validator for
  `items`, `nil` when it sent none.
  """
  @type view :: %{
          items: [map()],
          window: {integer(), integer()} | nil,
          etag: String.t() | nil,
          last_polled_at: DateTime.t() | nil,
          last_error: term(),
          stale: boolean()
        }

  defmodule State do
    @moduledoc false
    defstruct [
      :remotes,
      :client,
      :task_supervisor,
      :request_timeout_ms,
      :remotes_token,
      :store_dir,
      :window_ms,
      :freshness_ms,
      :wait_ms,
      :clock,
      reload_from_file?: false,
      # name => %{remote: %Remote{}, feeds: %{feed => feed_state}}
      entries: %{},
      # task ref => {name, feed, window}
      tasks: %{},
      # {name, feed} => task ref, the in-flight guard
      in_flight: %{},
      # waiter ref => %{from:, feed:, keys: [{name, feed}], timer:}
      waiters: %{}
    ]
  end

  # ── Client ──

  @doc """
  Starts the registry. Opts:

    * `:name`, `:remotes`, `:client`, `:task_supervisor`, `:request_timeout_ms`
      — as `Shuttle.RemoteFiberRegistry.start_link/1`.
    * `:store_dir` — directory the per-feed JSON caches live under. Defaults to
      `$SHUTTLE_DATA_DIR/remote-temporal` (`~/.shuttle/remote-temporal`).
    * `:window_ms` — trailing window width for activity. Defaults to
      #{@window_days} days.
    * `:freshness_ms` — the freshness gate. Defaults to #{@freshness_ms} ms.
    * `:wait_ms` — how long a request waits for its fetches. Defaults to
      #{@wait_ms} ms.
    * `:clock` — zero-arity fun returning the current `DateTime`, read for every
      attempt, success and staleness decision. Defaults to
      `&DateTime.utc_now/0`; tests pass a fake clock they advance.
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    # `name: nil` starts an unnamed instance (tests address theirs through
    # `Shuttle.Env.server/1`).
    case Keyword.get(opts, :name, __MODULE__) do
      nil -> GenServer.start_link(__MODULE__, opts)
      name -> GenServer.start_link(__MODULE__, opts, name: name)
    end
  end

  # The default on-disk home for the per-feed caches, honoring the same env
  # the rest of the daemon's host-local state does.
  defp default_store_dir, do: Path.join(Shuttle.data_dir(), "remote-temporal")

  @doc """
  Every remote's view of `feed`, keyed by remote name, after refreshing the
  remotes whose attempt at it is older than the freshness gate (see the
  moduledoc). Blocks for at most the registry's wait bound plus a margin.

  An empty map means no remotes are configured, or the registry isn't running
  — callers tolerate this for graceful degradation.
  """
  @spec entries(feed()) :: %{String.t() => view()}
  def entries(feed), do: entries(Shuttle.Env.server(__MODULE__), feed)

  @spec entries(GenServer.server(), feed()) :: %{String.t() => view()}
  def entries(server, feed) when feed in @feeds do
    RegistryCommon.read(server, {:entries, feed}, %{}, RegistryCommon.read_timeout_ms())
  end

  @doc """
  Synchronously fetches every feed of every remote once, ignoring the gate,
  and returns when all have been handled. Inline (no `Task`) — used by tests to
  prime the registry deterministically against a stub client.
  """
  @spec refresh_now() :: :ok
  def refresh_now, do: refresh_now(Shuttle.Env.server(__MODULE__))

  @spec refresh_now(GenServer.server()) :: :ok
  def refresh_now(server),
    do: GenServer.call(server, :refresh_now, RegistryCommon.read_timeout_ms())

  @doc """
  The activity window a fetch made at `now` asks for: `to_ms` is `now` ceiled
  to a #{div(@window_quantum_ms, 60_000)}-minute boundary and `from_ms` is
  `width_ms` before it. Public so the quantization is testable on its own.
  """
  @spec activity_window(DateTime.t(), pos_integer()) :: {integer(), integer()}
  def activity_window(%DateTime{} = now, width_ms \\ @window_ms) do
    now_ms = DateTime.to_unix(now, :millisecond)
    to_ms = -Integer.floor_div(-now_ms, @window_quantum_ms) * @window_quantum_ms
    {to_ms - width_ms, to_ms}
  end

  # ── Server ──

  @impl true
  def init(opts) do
    remotes = RegistryCommon.configured_remotes(opts)
    store_dir = Keyword.get(opts, :store_dir, default_store_dir())
    persisted = Map.new(@feeds, &{&1, RegistryCommon.load_all(feed_dir(store_dir, &1))})

    state = %State{
      remotes: remotes,
      reload_from_file?: not Keyword.has_key?(opts, :remotes),
      remotes_token: Shuttle.Remotes.config_token(),
      client: Keyword.get(opts, :client, Shuttle.RemoteRegistry.Client.Default),
      task_supervisor: Keyword.get(opts, :task_supervisor, Shuttle.TaskSupervisor),
      request_timeout_ms: Keyword.get(opts, :request_timeout_ms, @default_request_timeout_ms),
      store_dir: store_dir,
      window_ms: Keyword.get(opts, :window_ms, @window_ms),
      freshness_ms: Keyword.get(opts, :freshness_ms, @freshness_ms),
      wait_ms: Keyword.get(opts, :wait_ms, @wait_ms),
      clock: Keyword.get(opts, :clock, &DateTime.utc_now/0),
      entries: Map.new(remotes, &{&1.name, restore(&1, persisted)})
    }

    Logger.info(
      "RemoteTemporalRegistry: configured #{length(remotes)} remote(s): " <>
        inspect(Enum.map(remotes, & &1.name))
    )

    {:ok, state}
  end

  @impl true
  def handle_call({:entries, feed}, from, state) do
    state = state |> reload_remotes() |> start_due_fetches(feed)

    keys =
      for {name, _entry} <- state.entries,
          Map.has_key?(state.in_flight, {name, feed}),
          do: {name, feed}

    if keys == [] do
      {:reply, build_view(state, feed), state}
    else
      ref = make_ref()
      timer = Process.send_after(self(), {:wait_elapsed, ref}, state.wait_ms)
      waiter = %{from: from, feed: feed, keys: keys, timer: timer}
      {:noreply, %{state | waiters: Map.put(state.waiters, ref, waiter)}}
    end
  end

  def handle_call(:refresh_now, _from, state) do
    state = reload_remotes(state)

    state =
      for {name, entry} <- state.entries, feed <- @feeds, reduce: state do
        acc ->
          window = fetch_window(acc, feed)
          etag = entry.feeds[feed].etag
          result = fetch(acc.client, entry.remote, feed, etag, acc.request_timeout_ms, window)

          acc
          |> stamp_attempt(name, feed)
          |> apply_result(name, feed, window, result, now(acc))
      end

    {:reply, :ok, state}
  end

  @impl true
  def handle_info({ref, {name, feed, window, result}}, state) when is_reference(ref) do
    Process.demonitor(ref, [:flush])

    state
    |> finish_task(ref)
    |> apply_result(name, feed, window, result, now(state))
    |> settle_waiters()
    |> then(&{:noreply, &1})
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, state) when is_reference(ref) do
    case Map.get(state.tasks, ref) do
      nil ->
        {:noreply, state}

      {name, feed, window} ->
        Logger.warning(
          "RemoteTemporalRegistry: #{name} #{feed} fetch crashed: #{inspect(reason)}"
        )

        state
        |> finish_task(ref)
        |> apply_result(name, feed, window, {:error, reason}, now(state))
        |> settle_waiters()
        |> then(&{:noreply, &1})
    end
  end

  def handle_info({:wait_elapsed, ref}, state) do
    case Map.pop(state.waiters, ref) do
      {nil, _waiters} ->
        {:noreply, state}

      {waiter, waiters} ->
        state = %{state | waiters: waiters}
        GenServer.reply(waiter.from, build_view(state, waiter.feed))
        {:noreply, state}
    end
  end

  def handle_info(_msg, state), do: {:noreply, state}

  defp now(%State{clock: clock}), do: clock.()

  # ── Fleet reload ──

  defp reload_remotes(%State{} = state),
    do: RegistryCommon.reload_fleet(state, :entries, &initial_entry/1)

  # ── Fetch orchestration ──

  defp start_due_fetches(%State{} = state, feed) do
    now_ms = DateTime.to_unix(now(state), :millisecond)

    Enum.reduce(state.entries, state, fn {name, entry}, acc ->
      if Map.has_key?(acc.in_flight, {name, feed}) or
           not due?(entry.feeds[feed], now_ms, acc.freshness_ms) do
        acc
      else
        start_fetch(acc, name, entry, feed)
      end
    end)
  end

  defp due?(%{last_attempt_at: %DateTime{} = last}, now_ms, freshness_ms),
    do: now_ms - DateTime.to_unix(last, :millisecond) >= freshness_ms

  defp due?(_feed_state, _now_ms, _freshness_ms), do: true

  defp start_fetch(%State{} = state, name, entry, feed) do
    %{client: client, request_timeout_ms: timeout} = state
    # Bound before the closure: the task must not capture the whole state.
    remote = entry.remote
    etag = entry.feeds[feed].etag
    window = fetch_window(state, feed)

    task =
      Task.Supervisor.async_nolink(state.task_supervisor, fn ->
        {name, feed, window, fetch(client, remote, feed, etag, timeout, window)}
      end)

    state = stamp_attempt(state, name, feed)

    %{
      state
      | tasks: Map.put(state.tasks, task.ref, {name, feed, window}),
        in_flight: Map.put(state.in_flight, {name, feed}, task.ref)
    }
  end

  defp stamp_attempt(%State{} = state, name, feed) do
    now = now(state)
    entry = put_feed(state.entries[name], feed, &%{&1 | last_attempt_at: now})
    %{state | entries: Map.put(state.entries, name, entry)}
  end

  defp finish_task(%State{} = state, ref) do
    case Map.pop(state.tasks, ref) do
      {nil, _tasks} ->
        state

      {{name, feed, _window}, tasks} ->
        %{state | tasks: tasks, in_flight: Map.delete(state.in_flight, {name, feed})}
    end
  end

  # Answer every waiter none of whose fetches is still in flight.
  defp settle_waiters(%State{} = state) do
    {done, waiting} =
      Enum.split_with(state.waiters, fn {_ref, waiter} ->
        not Enum.any?(waiter.keys, &Map.has_key?(state.in_flight, &1))
      end)

    state = %{state | waiters: Map.new(waiting)}

    Enum.each(done, fn {_ref, waiter} ->
      Process.cancel_timer(waiter.timer)
      GenServer.reply(waiter.from, build_view(state, waiter.feed))
    end)

    state
  end

  # ── Fetching ──

  defp fetch_window(%State{window_ms: width} = state, :activity),
    do: activity_window(now(state), width)

  defp fetch_window(_state, _feed), do: nil

  defp url(remote, :activity, {from_ms, to_ms}), do: Remote.activity_url(remote, from_ms, to_ms)
  defp url(remote, :sessions, _window), do: Remote.sessions_url(remote)
  defp url(remote, :commits, _window), do: Remote.commits_url(remote)
  defp url(remote, :sent_files, _window), do: Remote.sent_files_all_url(remote)

  defp list_key(:activity), do: "buckets"
  defp list_key(:sessions), do: "records"
  defp list_key(:commits), do: "records"
  defp list_key(:sent_files), do: "files"

  # Conditional fetch, same contract as the fiber registry's: a 304 is SUCCESS
  # with unchanged data, a 200 carries the list and a fresh etag, anything else
  # is an error that leaves last-good data untouched. A client implementing only
  # the unconditional `get/2` falls back to it — correct, just without the 304.
  defp fetch(client, remote, feed, etag, timeout_ms, window) do
    case RegistryCommon.conditional_get(client, url(remote, feed, window), etag, timeout_ms) do
      {:ok, 304, _headers, _body} ->
        {:ok, :not_modified}

      {:ok, status, headers, body} when status in 200..299 ->
        decode(body, list_key(feed), RegistryCommon.header_value(headers, "etag"))

      {:ok, status, _headers, _body} ->
        {:error, {:http_status, status}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  # A well-formed envelope missing the list key is zero items, not a transport
  # failure — a host that has never run a worker serves exactly that.
  defp decode(body, key, etag) do
    case Jason.decode(body) do
      {:ok, %{} = envelope} -> {:ok, {list_or_empty(Map.get(envelope, key)), etag}}
      _ -> {:error, :malformed_json}
    end
  end

  # ── Entries ──

  defp initial_entry(%Remote{} = remote),
    do: %{remote: remote, feeds: Map.new(@feeds, &{&1, initial_feed()})}

  defp initial_feed do
    %{
      items: [],
      window: nil,
      etag: nil,
      last_polled_at: nil,
      last_attempt_at: nil,
      last_error: nil
    }
  end

  defp put_feed(entry, feed, fun), do: %{entry | feeds: Map.update!(entry.feeds, feed, fun)}

  # Fold one fetch result into its feed:
  #   * 200 → take the items, the fresh etag and (activity) the window; persist.
  #   * 304 → keep the items and the etag; nothing moved.
  #   * error → keep everything; only `last_error` records it.
  # Both successes advance `last_polled_at` and clear `last_error`. A result
  # for a remote a fleet reload dropped mid-fetch is discarded rather than
  # resurrecting an entry nothing would evict.
  defp apply_result(%State{} = state, name, feed, window, result, now) do
    case Map.get(state.entries, name) do
      nil ->
        state

      entry ->
        entry = put_feed(entry, feed, &fold(&1, result, window, now))

        if match?({:ok, {_items, _etag}}, result),
          do: persist(state.store_dir, feed, name, entry.feeds[feed])

        %{state | entries: Map.put(state.entries, name, entry)}
    end
  end

  defp fold(feed_state, {:ok, :not_modified}, _window, now),
    do: %{feed_state | last_polled_at: now, last_error: nil}

  defp fold(feed_state, {:ok, {items, etag}}, window, now),
    do: %{
      feed_state
      | items: items,
        etag: etag,
        window: window,
        last_polled_at: now,
        last_error: nil
    }

  defp fold(feed_state, {:error, reason}, _window, _now), do: %{feed_state | last_error: reason}

  # ── Views ──

  defp build_view(%State{} = state, feed) do
    now = now(state)
    stale_after_ms = state.freshness_ms * @stale_after_gates

    Map.new(state.entries, fn {name, entry} ->
      feed_state = entry.feeds[feed]

      {name,
       %{
         items: feed_state.items,
         window: feed_state.window,
         etag: feed_state.etag,
         last_polled_at: feed_state.last_polled_at,
         last_error: feed_state.last_error,
         stale: stale?(feed_state.last_polled_at, now, stale_after_ms)
       }}
    end)
  end

  defp stale?(nil, _now, _stale_after_ms), do: true

  defp stale?(%DateTime{} = last, now, stale_after_ms),
    do: DateTime.diff(now, last, :millisecond) > stale_after_ms

  # ── Disk persistence ──
  #
  # The feature's whole claim is that the hub remembers a remote it cannot
  # reach. A daemon restart is indistinguishable from a disconnect at the UI, so
  # the cache has to outlive the process. One JSON file per feed per remote,
  # written atomically (tmp + rename) so a crash mid-write cannot leave a
  # half-file that poisons the next boot.
  #
  # Only a 200 is written: it is the only result that changes the data, and
  # the etag written beside the items always describes them. The persisted
  # `last_polled_at` is therefore the last 200, which is never later than the
  # last success — a restored feed can read older than it was, never fresher.
  #
  # The `:remote` struct is deliberately NOT persisted: it is fleet config, and
  # config is authoritative at boot. Restoring a stale port from a month-old
  # cache is exactly the bug this avoids.

  defp feed_dir(store_dir, feed), do: Path.join(store_dir, Atom.to_string(feed))

  defp persist(dir, feed, name, feed_state) do
    RegistryCommon.persist(
      feed_dir(dir, feed),
      name,
      %{
        "items" => feed_state.items,
        "window" => encode_window(feed_state.window),
        "etag" => feed_state.etag,
        "last_polled_at" => RegistryCommon.encode_dt(feed_state.last_polled_at)
      },
      "RemoteTemporalRegistry"
    )
  end

  defp encode_window({from_ms, to_ms}), do: [from_ms, to_ms]
  defp encode_window(_), do: nil

  # A restored feed keeps `last_attempt_at` nil, so the first request after
  # boot fetches it at once.
  defp restore(%Remote{} = remote, persisted) do
    safe = RegistryCommon.safe_name(remote.name)
    entry = initial_entry(remote)

    Enum.reduce(@feeds, entry, fn feed, acc ->
      case get_in(persisted, [feed, safe]) do
        %{} = saved -> put_feed(acc, feed, &restore_feed(&1, saved))
        _ -> acc
      end
    end)
  end

  defp restore_feed(feed_state, saved) do
    %{
      feed_state
      | items: list_or_empty(saved["items"]),
        window: decode_window(saved["window"]),
        etag: if(is_binary(saved["etag"]), do: saved["etag"]),
        last_polled_at: RegistryCommon.decode_dt(saved["last_polled_at"])
    }
  end

  defp list_or_empty(value) when is_list(value), do: value
  defp list_or_empty(_), do: []

  defp decode_window([from_ms, to_ms]) when is_integer(from_ms) and is_integer(to_ms),
    do: {from_ms, to_ms}

  defp decode_window(_), do: nil
end
