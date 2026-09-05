defmodule Shuttle.RemoteTemporalRegistry do
  @moduledoc """
  Polls each configured remote Shuttle daemon's five **temporal** feeds —
  `/activity`, `/sessions`, `/commits`, `/spend`, `/sent-files/all` — caches them per origin, and persists
  each cache to disk so the hub's memory of a remote survives both a disconnect
  and a daemon restart.

  This is the third registry, sibling to `Shuttle.RemoteRegistry` (liveness
  probe + recovery cascade) and `Shuttle.RemoteFiberRegistry` (the kanban
  feed). It mirrors the fiber registry's structure deliberately — same client
  behaviour, same conditional fetch, same "an error never clears data" rule —
  and diverges in exactly three ways, each for a reason:

    * **A slower cadence.** Telemetry is not liveness. Nothing here drives
      recovery or a badge that must flip in seconds, so the poll interval is
      `@poll_interval_multiplier ×` the remote's `poll_interval_ms` (~30s at
      the 5s default).

    * **Five feeds per remote, one task.** The GETs run sequentially
      inside one supervised task per remote. Each feed applies independently:
      a partial tick (activity 200s, commits times out) keeps last-good
      commits and takes the new activity.

    * **Disk persistence.** On every successful refresh the entry is written
      as JSON under `$SHUTTLE_DATA_DIR/remote-temporal/<name>.json` and read
      back at init. The whole point of the feature is a temporal view that
      still shows a remote's last two weeks while that host is unreachable —
      memory that evaporates on a daemon bounce would not deliver that.

  ## The window

  Activity is fetched over a **trailing 14-day window**, refetched
  whole on each tick rather than merged incrementally. Minute buckets are
  immutable once past, so a full refetch is redundant — but it is redundant
  behind an `If-None-Match`, which makes the common case a 304 with no body.
  Simplicity wins over an incremental merge that would have to reason about
  clock skew and late-arriving lines.

  Each cached entry records the window it actually covers. A composite request
  for a wider window is served what is cached, and the covered window is
  reported back in the origins block — the UI says "remote: 14 days, last seen
  2h ago" rather than silently implying the gap is quiet.

  ## Test injection

  Same as the fiber registry: the HTTP transport is the
  `Shuttle.RemoteRegistry.Client` behaviour, tests start with `auto_poll: false`
  and drive synchronously with `refresh_now/1`, which fetches inline.
  """

  use GenServer
  require Logger

  alias Shuttle.RegistryCommon
  alias Shuttle.Remote

  @default_tick_interval_ms 1_000
  @default_request_timeout_ms 20_000

  # Telemetry is not liveness: poll at a multiple of the remote's own cadence.
  @poll_interval_multiplier 6

  # The trailing window activity is cached over.
  @window_days 14
  @window_ms @window_days * 24 * 60 * 60 * 1_000

  @feeds [:activity, :sessions, :commits, :spend, :sent_files]

  defmodule State do
    @moduledoc false
    defstruct [
      :remotes,
      :client,
      :task_supervisor,
      :tick_timer_ref,
      :tick_interval_ms,
      :request_timeout_ms,
      :remotes_token,
      :store_dir,
      :window_ms,
      reload_from_file?: false,
      entries: %{},
      # ref => remote name, for the in-flight fetch guard
      tasks: %{}
    ]
  end

  # ── Client ──

  @doc """
  Starts the registry. Accepts the same opts as
  `Shuttle.RemoteFiberRegistry.start_link/1`, plus:

    * `:store_dir` — directory the per-remote JSON caches live in. Defaults to
      `$SHUTTLE_DATA_DIR/remote-temporal` (`~/.shuttle/remote-temporal`).
    * `:window_ms` — trailing window width for activity. Defaults to
      #{@window_days} days.
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  The default on-disk home for the per-remote caches, honoring the same env the
  rest of the daemon's host-local state does.
  """
  @spec default_store_dir() :: String.t()
  def default_store_dir do
    Path.join(
      System.get_env("SHUTTLE_DATA_DIR") ||
        Path.join(System.user_home!() || "/root", ".shuttle"),
      "remote-temporal"
    )
  end

  @doc """
  The cached temporal entries keyed by remote name. Each value carries
  `:activity_buckets`, `:activity_spawns`, `:activity_window`, `:sessions`, `:commits`,
  `:spend`, `:last_polled_at`, `:last_error`, and
  `:stale`.

  An empty map means no remotes are configured (or the registry isn't running —
  callers tolerate this for graceful degradation).
  """
  @spec entries() :: %{String.t() => map()}
  def entries, do: entries(__MODULE__)

  @spec entries(GenServer.server()) :: %{String.t() => map()}
  def entries(server), do: entries(server, RegistryCommon.read_timeout_ms())

  @spec entries(GenServer.server(), non_neg_integer()) :: %{String.t() => map()}
  def entries(server, timeout_ms) when is_integer(timeout_ms) and timeout_ms >= 0 do
    if RegistryCommon.registry_alive?(server) do
      GenServer.call(server, :entries, timeout_ms)
    else
      %{}
    end
  end

  @doc """
  Synchronously fetches every remote's five feeds once and returns when all
  have been handled. Inline (no `Task`) — used by tests to drive the registry
  deterministically against a stub client.
  """
  @spec refresh_now() :: :ok
  def refresh_now, do: refresh_now(__MODULE__)

  @spec refresh_now(GenServer.server()) :: :ok
  def refresh_now(server),
    do: GenServer.call(server, :refresh_now, RegistryCommon.read_timeout_ms())

  # ── Server ──

  @impl true
  def init(opts) do
    remotes = RegistryCommon.configured_remotes(opts)
    store_dir = Keyword.get(opts, :store_dir, default_store_dir())
    persisted = load_all(store_dir)

    state = %State{
      remotes: remotes,
      reload_from_file?: not Keyword.has_key?(opts, :remotes),
      remotes_token: Shuttle.Remotes.config_token(),
      client: Keyword.get(opts, :client, Shuttle.RemoteRegistry.Client.Default),
      task_supervisor: Keyword.get(opts, :task_supervisor, Shuttle.TaskSupervisor),
      tick_interval_ms: Keyword.get(opts, :tick_interval_ms, @default_tick_interval_ms),
      request_timeout_ms: Keyword.get(opts, :request_timeout_ms, @default_request_timeout_ms),
      store_dir: store_dir,
      window_ms: Keyword.get(opts, :window_ms, @window_ms),
      entries:
        Map.new(remotes, fn remote ->
          {remote.name, restore(Map.get(persisted, safe_name(remote.name)), remote)}
        end)
    }

    auto_poll = Keyword.get(opts, :auto_poll, true)

    Logger.info(
      "RemoteTemporalRegistry: configured #{length(remotes)} remote(s): " <>
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
  def handle_call(:entries, _from, state) do
    {:reply, build_view(state), state}
  end

  def handle_call(:refresh_now, _from, state) do
    state = reload_remotes(state)
    now = DateTime.utc_now()
    window = window(state, now)

    entries =
      Enum.reduce(state.remotes, state.entries, fn remote, acc ->
        entry = Map.get(acc, remote.name, initial_entry(remote))
        results = fetch_all(remote, entry, state.client, state.request_timeout_ms, window)
        updated = apply_results(entry, results, window, now)
        persist(state.store_dir, remote.name, updated)
        Map.put(acc, remote.name, updated)
      end)

    {:reply, :ok, %{state | entries: entries}}
  end

  @impl true
  def handle_info({:tick, _token}, state) do
    state = start_due_fetches(state)
    state = RegistryCommon.schedule_tick(state, state.tick_interval_ms)
    {:noreply, state}
  end

  def handle_info({ref, {name, results, window}}, state) when is_reference(ref) do
    Process.demonitor(ref, [:flush])
    {:noreply, record_task_result(state, ref, name, results, window)}
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, state) when is_reference(ref) do
    case Map.pop(state.tasks, ref) do
      {nil, _tasks} ->
        {:noreply, state}

      {name, tasks} ->
        Logger.warning(
          "RemoteTemporalRegistry: #{name} temporal fetch crashed: #{inspect(reason)}"
        )

        entries = record_failure(state.entries, name, reason, DateTime.utc_now())
        {:noreply, %{state | tasks: tasks, entries: entries}}
    end
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # ── Fleet reload ──

  defp reload_remotes(%State{reload_from_file?: false} = state), do: state

  defp reload_remotes(%State{} = state) do
    case Shuttle.Remotes.config_token() do
      token when token == state.remotes_token ->
        state

      token ->
        remotes = RegistryCommon.configured_remotes()

        %{
          state
          | remotes: remotes,
            remotes_token: token,
            entries: RegistryCommon.reconcile(state.entries, remotes, &initial_entry/1)
        }
    end
  end

  # ── Fetch orchestration ──

  defp start_due_fetches(%State{} = state) do
    state = reload_remotes(state)
    now = DateTime.utc_now()
    now_ms = DateTime.to_unix(now, :millisecond)
    window = window(state, now)
    in_flight = MapSet.new(Map.values(state.tasks))

    Enum.reduce(state.remotes, state, fn remote, acc ->
      entry = Map.get(acc.entries, remote.name, initial_entry(remote))

      if MapSet.member?(in_flight, remote.name) or not due?(entry, remote, now_ms) do
        acc
      else
        start_fetch(acc, remote, entry, window)
      end
    end)
  end

  # Gate on `last_attempt_at` (not `last_polled_at`) so a permanently-slow
  # origin retries at its cadence rather than every tick — same rule as the
  # fiber registry, just at the telemetry multiple.
  defp due?(%{last_attempt_at: %DateTime{} = last}, %Remote{} = remote, now_ms) do
    now_ms - DateTime.to_unix(last, :millisecond) >= poll_interval_ms(remote)
  end

  defp due?(_entry, _remote, _now_ms), do: true

  defp poll_interval_ms(%Remote{poll_interval_ms: ms}), do: ms * @poll_interval_multiplier

  defp start_fetch(%State{} = state, %Remote{} = remote, entry, window) do
    client = state.client
    timeout = state.request_timeout_ms
    name = remote.name

    task =
      Task.Supervisor.async_nolink(state.task_supervisor, fn ->
        {name, fetch_all(remote, entry, client, timeout, window), window}
      end)

    entries = stamp_attempt(state.entries, remote)
    %{state | tasks: Map.put(state.tasks, task.ref, name), entries: entries}
  end

  defp record_task_result(%State{} = state, ref, name, results, window) do
    case Map.pop(state.tasks, ref) do
      {nil, _tasks} ->
        state

      {_name, tasks} ->
        entry = Map.get(state.entries, name, initial_entry_for(state, name))
        updated = apply_results(entry, results, window, DateTime.utc_now())
        persist(state.store_dir, name, updated)
        %{state | tasks: tasks, entries: Map.put(state.entries, name, updated)}
    end
  end

  # ── Fetching ──

  # Trailing window, recomputed each tick. Activity rides it; sessions,
  # commits, and spend ask for the whole ledger, which is one line per
  # session / one line per commit.
  defp window(%State{window_ms: width}, now) do
    to_ms = DateTime.to_unix(now, :millisecond)
    {to_ms - width, to_ms}
  end

  # The five GETs, sequential inside one task. Returns a keyword-shaped map of
  # per-feed results so `apply_results/4` can take the successes and leave the
  # failures' last-good data alone, feed by feed.
  defp fetch_all(%Remote{} = remote, entry, client, timeout_ms, {from_ms, to_ms}) do
    etags = Map.get(entry, :etags) || %{}

    %{
      activity:
        fetch(client, Remote.activity_url(remote, from_ms, to_ms), etags[:activity], timeout_ms,
          key: "buckets",
          also: ["spawns"]
        ),
      sessions:
        fetch(client, Remote.sessions_url(remote), etags[:sessions], timeout_ms,
          key: "records"
        ),
      commits:
        fetch(client, Remote.commits_url(remote), etags[:commits], timeout_ms, key: "records"),
      spend:
        fetch(client, Remote.spend_url(remote), etags[:spend], timeout_ms, key: "sessions"),
      sent_files:
        fetch(client, Remote.sent_files_all_url(remote), etags[:sent_files], timeout_ms,
          key: "files"
        )
    }
  end

  # Conditional fetch, same contract as the fiber registry's: a 304 is SUCCESS
  # with unchanged data, a 200 carries the list and a fresh etag, anything else
  # is an error that leaves last-good data untouched. A client implementing only
  # the unconditional `get/2` falls back to it — correct, just without the 304.
  defp fetch(client, url, etag, timeout_ms, opts) do
    key = Keyword.fetch!(opts, :key)
    also = Keyword.get(opts, :also, [])

    case conditional_get(client, url, etag, timeout_ms) do
      {:ok, 304, _headers, _body} ->
        {:ok, :not_modified}

      {:ok, status, headers, body} when status in 200..299 ->
        decode(body, key, also, header_value(headers, "etag"))

      {:ok, status, _headers, _body} ->
        {:error, {:http_status, status}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp conditional_get(client, url, etag, timeout_ms) do
    if function_exported?(client, :get, 3) do
      headers = if is_binary(etag), do: [{"if-none-match", etag}], else: []
      client.get(url, headers, timeout_ms)
    else
      case client.get(url, timeout_ms) do
        {:ok, body} -> {:ok, 200, [], body}
        {:error, reason} -> {:error, reason}
      end
    end
  end

  # A well-formed envelope missing the list key is zero items, not a transport
  # failure — a host that has never run a worker serves exactly that. `also`
  # names the envelope's SIDE lists (activity's `spawns`), which are carried in
  # a map beside the primary one; a remote too old to serve one simply has none.
  defp decode(body, key, also, etag) do
    case Jason.decode(body) do
      {:ok, %{} = envelope} ->
        items = list_or_empty(Map.get(envelope, key))
        {:ok, {items, Map.new(also, &{&1, list_or_empty(Map.get(envelope, &1))}), etag}}

      _ ->
        {:error, :malformed_json}
    end
  end

  defp header_value(headers, key) do
    Enum.find_value(headers, fn {k, v} -> if k == key, do: v end)
  end

  # ── Entries ──

  defp initial_entry(%Remote{} = remote) do
    %{
      activity_buckets: [],
      activity_spawns: [],
      activity_window: nil,
      sessions: [],
      commits: [],
      spend: [],
      sent_files: [],
      etags: %{},
      last_polled_at: nil,
      last_attempt_at: nil,
      last_error: nil,
      remote: remote
    }
  end

  defp initial_entry_for(%State{remotes: remotes}, name) do
    case Enum.find(remotes, &(&1.name == name)) do
      %Remote{} = remote -> initial_entry(remote)
      _ -> %{initial_entry(%Remote{name: name, url: ""}) | remote: nil}
    end
  end

  defp stamp_attempt(entries, %Remote{name: name} = remote) do
    entry = Map.get(entries, name, initial_entry(remote))
    Map.put(entries, name, %{entry | last_attempt_at: DateTime.utc_now()})
  end

  # Fold the per-feed results into the entry.
  #
  # The rules, identical to the fiber registry's and applied PER FEED:
  #   * 200 → take the items and the fresh etag.
  #   * 304 → keep the items and the etag; nothing moved.
  #   * error → keep everything; only `last_error` records it.
  #
  # `last_polled_at` (the timestamp staleness is measured from) advances when
  # AT LEAST ONE feed succeeded, and `last_error` is set when at least one
  # failed. A tick where activity lands and commits times out is therefore
  # fresh-with-an-error: the data on screen is current, and the origins block
  # still tells the truth about the failure.
  defp apply_results(entry, results, window, now) do
    entry =
      Enum.reduce(@feeds, entry, fn feed, acc -> apply_feed(acc, feed, results[feed], window) end)

    errors = for {_feed, {:error, reason}} <- results, do: reason

    cond do
      length(errors) == length(@feeds) ->
        Logger.debug("RemoteTemporalRegistry: all temporal feeds failed: #{inspect(errors)}")
        %{entry | last_attempt_at: now, last_error: List.first(errors)}

      errors != [] ->
        %{entry | last_polled_at: now, last_attempt_at: now, last_error: List.first(errors)}

      true ->
        %{entry | last_polled_at: now, last_attempt_at: now, last_error: nil}
    end
  end

  defp apply_feed(entry, _feed, {:ok, :not_modified}, _window), do: entry
  defp apply_feed(entry, _feed, {:error, _reason}, _window), do: entry

  defp apply_feed(entry, feed, {:ok, {items, extras, etag}}, window) do
    entry
    |> put_items(feed, items, extras, window)
    |> Map.put(:etags, Map.put(entry.etags || %{}, feed, etag))
  end

  defp put_items(entry, :activity, items, extras, window),
    do: %{
      entry
      | activity_buckets: items,
        activity_spawns: Map.get(extras, "spawns", []),
        activity_window: window
    }

  defp put_items(entry, :sessions, items, _extras, _window), do: %{entry | sessions: items}
  defp put_items(entry, :commits, items, _extras, _window), do: %{entry | commits: items}
  defp put_items(entry, :spend, items, _extras, _window), do: %{entry | spend: items}
  defp put_items(entry, :sent_files, items, _extras, _window), do: %{entry | sent_files: items}

  defp record_failure(entries, name, reason, now) do
    case Map.get(entries, name) do
      nil -> entries
      entry -> Map.put(entries, name, %{entry | last_attempt_at: now, last_error: reason})
    end
  end

  # ── Views ──

  defp build_view(%State{} = state) do
    now = DateTime.utc_now()

    Map.new(state.entries, fn {name, entry} ->
      {name,
       %{
         activity_buckets: entry.activity_buckets,
         activity_spawns: entry.activity_spawns,
         activity_window: entry.activity_window,
         sessions: entry.sessions,
         commits: entry.commits,
         spend: entry.spend,
         sent_files: entry.sent_files,
         last_polled_at: entry.last_polled_at,
         last_error: entry.last_error,
         stale: stale?(entry, now)
       }}
    end)
  end

  # Same rule as the fiber registry, at this registry's slower cadence: stale
  # iff the last SUCCESS is older than stale_multiplier × the telemetry poll
  # interval. A failure never sets a flag; it only withholds a fresh timestamp.
  defp stale?(%{remote: %Remote{} = remote, last_polled_at: last}, now) do
    Remote.stale?(%{remote | poll_interval_ms: poll_interval_ms(remote)}, last, now)
  end

  defp stale?(_entry, _now), do: true

  # ── Disk persistence ──
  #
  # The feature's whole claim is that the hub remembers a remote it cannot
  # reach. A daemon restart is indistinguishable from a disconnect at the UI, so
  # the cache has to outlive the process. One JSON file per remote, written
  # atomically (tmp + rename) so a crash mid-write cannot leave a half-file that
  # poisons the next boot.
  #
  # The `:remote` struct is deliberately NOT persisted: it is fleet config, and
  # config is authoritative at boot. Restoring a stale port from a month-old
  # cache is exactly the bug this avoids.

  defp persist(nil, _name, _entry), do: :ok

  defp persist(dir, name, entry) do
    File.mkdir_p!(dir)
    path = Path.join(dir, "#{safe_name(name)}.json")
    tmp = path <> ".tmp"
    File.write!(tmp, Jason.encode!(encode_entry(entry)))
    File.rename!(tmp, path)
    :ok
  rescue
    error ->
      Logger.debug("RemoteTemporalRegistry: persist for #{name} failed — #{inspect(error)}")
      :ok
  end

  # A remote name is a routing key and a hostname, but it reaches a path here,
  # so anything that is not a plain filename character is flattened.
  defp safe_name(name), do: String.replace(name, ~r/[^A-Za-z0-9_.-]/, "_")

  defp encode_entry(entry) do
    %{
      "activity_buckets" => entry.activity_buckets,
      "activity_spawns" => entry.activity_spawns,
      "activity_window" => encode_window(entry.activity_window),
      "sessions" => entry.sessions,
      "commits" => entry.commits,
      "spend" => entry.spend,
      "sent_files" => entry.sent_files,
      "etags" => Map.new(entry.etags || %{}, fn {k, v} -> {Atom.to_string(k), v} end),
      "last_polled_at" => encode_dt(entry.last_polled_at)
    }
  end

  defp encode_window({from_ms, to_ms}), do: [from_ms, to_ms]
  defp encode_window(_), do: nil

  defp encode_dt(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
  defp encode_dt(_), do: nil

  defp load_all(nil), do: %{}

  defp load_all(dir) do
    case File.ls(dir) do
      {:ok, files} ->
        files
        |> Enum.filter(&String.ends_with?(&1, ".json"))
        |> Map.new(fn file ->
          {Path.rootname(file), load_file(Path.join(dir, file))}
        end)

      _ ->
        %{}
    end
  end

  defp load_file(path) do
    with {:ok, raw} <- File.read(path),
         {:ok, %{} = decoded} <- Jason.decode(raw) do
      decoded
    else
      _ -> nil
    end
  end

  # A persisted entry is last-good data with NO success timestamp of its own
  # beyond what it recorded: it restores `last_polled_at` so the origin reads
  # honestly as "last seen at T" (almost always already stale) rather than
  # fresh. `last_attempt_at` stays nil so the first tick after boot polls
  # immediately.
  defp restore(nil, remote), do: initial_entry(remote)

  defp restore(%{} = persisted, remote) do
    %{
      initial_entry(remote)
      | activity_buckets: list_or_empty(persisted["activity_buckets"]),
        activity_spawns: list_or_empty(persisted["activity_spawns"]),
        activity_window: decode_window(persisted["activity_window"]),
        sessions: list_or_empty(persisted["sessions"]),
        commits: list_or_empty(persisted["commits"]),
        spend: list_or_empty(persisted["spend"]),
        sent_files: list_or_empty(persisted["sent_files"]),
        etags: decode_etags(persisted["etags"]),
        last_polled_at: decode_dt(persisted["last_polled_at"])
    }
  end

  defp list_or_empty(value) when is_list(value), do: value
  defp list_or_empty(_), do: []

  defp decode_window([from_ms, to_ms]) when is_integer(from_ms) and is_integer(to_ms),
    do: {from_ms, to_ms}

  defp decode_window(_), do: nil

  defp decode_etags(%{} = etags) do
    Map.new(@feeds, fn feed -> {feed, etags[Atom.to_string(feed)]} end)
    |> Map.reject(fn {_k, v} -> is_nil(v) end)
  end

  defp decode_etags(_), do: %{}

  defp decode_dt(value) when is_binary(value) do
    case DateTime.from_iso8601(value) do
      {:ok, dt, _offset} -> dt
      _ -> nil
    end
  end

  defp decode_dt(_), do: nil
end
