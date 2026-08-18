defmodule Shuttle.FeltStores do
  @moduledoc """
  Reads and persists felt's configured store list.

  Resolution order:

    1. `FELT_STORES` env (comma-separated)
    2. persisted registry `~/.config/felt/stores.json`

  The registry is the source of truth — there is no implicit default store. An
  empty env *and* an empty/absent registry resolve to `[]`; register a store
  explicitly. Saving an empty list deletes the registry file.
  """

  require Logger

  alias Shuttle.PathListConfig

  @spec_ %{
    env: "FELT_STORES",
    config_env: "FELT_STORES_FILE",
    default_path: "~/.config/felt/stores.json",
    json_key: "felt_stores"
  }

  @type host_list :: [String.t()]

  @expanded_cache_key {__MODULE__, :expanded_hosts}
  @scan_lock_key {__MODULE__, :expansion_scan}
  @scan_report_key {__MODULE__, :expansion_scan_report}
  @expanded_cache_ttl_ms 30_000

  # How long a cold caller — one with no expansion cached for the CURRENT base
  # list — waits for the background scan before giving up and serving the
  # unexpanded base. Calibrated against a real store rather than a guess: the
  # author's own `~/loom` (one store, a deep tree, several symlinked substores)
  # scans in ~1.1 s warm, which is also what the old inline expansion charged
  # some unlucky request every 30 s. So this is a small multiple of a HEALTHY
  # walk, not a latency target — and still two orders of magnitude below the
  # stall it exists to bound, where the thing being waited on is a person.
  @scan_wait_ms 2_000

  # A scan that has not reported back within this window is presumed wedged
  # rather than merely slow, and the next caller is allowed to start another.
  # Long on purpose: a wedged scan is parked in a blocking filesystem call and
  # holds one of the VM's async I/O threads until the kernel releases it, so
  # re-arming often is how a stalled store turns into a stalled node.
  @scan_lock_ttl_ms 60_000

  # A scan slower than this is reported by name, at :warning, with what usually
  # causes it. Set above a healthy real store (~1.1 s, measured) with room to
  # spare, so this fires for trouble rather than for size: the stall it is
  # hunting runs to tens of seconds.
  @slow_scan_warn_ms 5_000

  @doc """
  The configured store list, expanded with any symlinked substores.

  **This call never blocks on the filesystem for longer than #{@scan_wait_ms} ms,
  and normally does no filesystem work at all.** That bound is load-bearing, not
  hygiene: `configured_hosts/0` is on the request path of most read endpoints
  (`/api/v1/fibers/composite`, `/api/v1/felt-stores`) as well as every poll, and
  the expansion it caches is a raw `File.ls`/`File.lstat`/`File.dir?` walk of
  each store's `.felt/`. Those calls have no timeout. Reach into a store macOS
  guards — iCloud Drive, `~/Library/CloudStorage` — and the first walk raises a
  consent dialog that blocks the calling process *for as long as the dialog goes
  unanswered*, which is human time, not machine time. Serving that walk inline
  is how an unanswered dialog behind another window took the whole API down for
  95 seconds on a first install (see the constitution
  `professional-open-source/idea-discovery-off-the-poller-process`).

  So the walk runs in a background task and reads consult a `:persistent_term`
  cache:

    * **Fresh** (cached for this base, within the #{@expanded_cache_ttl_ms} ms
      TTL) — returned as-is. No filesystem, no spawn.
    * **Stale** (cached for this base, past the TTL) — the stale list is
      returned *immediately* and a rescan is kicked off behind it. A store that
      cannot be walked degrades the freshness of the store list, never the
      availability of the endpoint reading it.
    * **Cold** (nothing cached for this base — first call, or the operator just
      changed `FELT_STORES`) — a rescan is kicked off and we wait up to
      #{@scan_wait_ms} ms for it, so a healthy filesystem still behaves
      synchronously and callers see substores on the first call. Past that
      deadline the *unexpanded* base list is served: correct, just missing
      symlinked substores, and self-healing the moment the scan lands.

  The scan is single-flight (`@scan_lock_key`), so a stalled store yields one
  blocked task rather than one per request.
  """
  @spec configured_hosts() :: host_list()
  def configured_hosts do
    base = configured_base_hosts()
    now = System.monotonic_time(:millisecond)

    case :persistent_term.get(@expanded_cache_key, :none) do
      {^base, expanded, cached_at} when now - cached_at < @expanded_cache_ttl_ms ->
        expanded

      {^base, expanded, _stale_at} ->
        start_expansion_scan(base)
        expanded

      _ ->
        start_expansion_scan(base)
        await_expansion(base, now + scan_wait_ms()) || unexpanded(base)
    end
  end

  # Poll the cache rather than await a task reference: the scan's result is
  # installed by whoever runs it, so a caller that gives up waiting costs
  # nothing and a caller that never existed still gets the scan done. Waiting on
  # a message would tie the result to one process's mailbox and lose it when a
  # request process dies at its own timeout.
  defp await_expansion(base, deadline) do
    case :persistent_term.get(@expanded_cache_key, :none) do
      {^base, expanded, _} ->
        expanded

      _ ->
        if System.monotonic_time(:millisecond) >= deadline do
          Logger.warning(
            "felt-store scan still running after #{scan_wait_ms()}ms; serving the unexpanded " <>
              "store list (#{Enum.join(base, ", ")}). On macOS this is usually a consent " <>
              "dialog waiting on a human — look behind your other windows. Symlinked " <>
              "substores stay hidden until the scan finishes."
          )

          nil
        else
          Process.sleep(10)
          await_expansion(base, deadline)
        end
    end
  end

  # The safe fallback: every configured store, expanded to an absolute path, with
  # no symlink resolution at all. Deliberately does NOT dedup by
  # `store_felt_realpath/1` the way a real expansion does — that is itself
  # filesystem work, and this branch exists precisely because the filesystem is
  # not answering.
  defp unexpanded(base), do: base |> Enum.map(&Path.expand/1) |> Enum.uniq()

  # Single-flight: at most one scan in flight per `@scan_lock_ttl_ms`. The check
  # is not atomic across processes, so a burst can race two scans through — that
  # is harmless (both write the same answer) and cheaper than serializing every
  # caller through a process that a wedged walk could itself block.
  defp start_expansion_scan(base) do
    now = System.monotonic_time(:millisecond)

    case :persistent_term.get(@scan_lock_key, nil) do
      started when is_integer(started) and now - started < @scan_lock_ttl_ms ->
        :ok

      _ ->
        :persistent_term.put(@scan_lock_key, now)

        spawn_expansion_scan(base)
    end
  end

  # No task supervisor — a unit test with the app not started, a supervisor
  # mid-restart — falls back to today's inline behaviour rather than never
  # scanning at all. The caller blocks, exactly as it always did.
  defp spawn_expansion_scan(base) do
    case Task.Supervisor.start_child(Shuttle.TaskSupervisor, fn -> run_expansion_scan(base) end) do
      {:ok, _pid} -> :ok
      _ -> run_expansion_scan(base)
    end
  catch
    :exit, _ -> run_expansion_scan(base)
  end

  defp run_expansion_scan(base) do
    {scanned_us, {expanded, timings}} = :timer.tc(fn -> expand_with_timings(base) end)
    :persistent_term.put(@expanded_cache_key, {base, expanded, System.monotonic_time(:millisecond)})
    :persistent_term.put(@scan_report_key, %{scanned_ms: div(scanned_us, 1000), stores: timings})
    log_scan(div(scanned_us, 1000), timings)
  after
    :persistent_term.erase(@scan_lock_key)
  end

  @doc """
  What the last completed store scan cost, per store, in milliseconds.

  `%{scanned_ms: integer, stores: %{store => ms}}`, or `nil` before the first
  scan completes. Read by `/api/v1/felt-stores` so a store that is slow — or
  currently unreadable — is a visible fact about the world rather than a line in
  a log nobody is tailing.
  """
  @spec last_scan_report() :: %{scanned_ms: non_neg_integer(), stores: map()} | nil
  def last_scan_report, do: :persistent_term.get(@scan_report_key, nil)

  @doc """
  True while a store scan is in flight — i.e. the store list on offer may be
  stale, and on macOS a consent dialog may be waiting on a human.
  """
  @spec scan_in_flight?() :: boolean()
  def scan_in_flight? do
    case :persistent_term.get(@scan_lock_key, nil) do
      started when is_integer(started) ->
        System.monotonic_time(:millisecond) - started < @scan_lock_ttl_ms

      _ ->
        false
    end
  end

  # Name the slow store, not just the slow scan: "which one" is the first thing
  # an operator staring at a stalled board needs, and on macOS it is also the
  # answer — the store in the file provider is the one holding the dialog.
  defp log_scan(total_ms, timings) when total_ms >= @slow_scan_warn_ms do
    slowest =
      timings
      |> Enum.sort_by(&(-elem(&1, 1)))
      |> Enum.take(3)
      |> Enum.map_join(", ", fn {store, ms} -> "#{store} #{ms}ms" end)

    Logger.warning(
      "felt-store scan took #{total_ms}ms (slowest: #{slowest}). A walk this slow is almost " <>
        "always a macOS consent dialog on an iCloud/CloudStorage store — look behind your " <>
        "other windows — or a store evicted by Optimize Mac Storage."
    )
  end

  defp log_scan(total_ms, _timings), do: Logger.debug("felt-store scan took #{total_ms}ms")

  defp scan_wait_ms, do: Application.get_env(:shuttle, :store_scan_wait_ms, @scan_wait_ms)

  @doc """
  The configured store list before symlink-substore expansion.

  This is the human-curated registry: `FELT_STORES` when explicitly set,
  otherwise the persisted `~/.config/felt/stores.json` list. Use this for picker
  surfaces that should reflect the canonical city list. Use `configured_hosts/0`
  for daemon polling/resolution, where symlinked substores must be expanded.
  """
  @spec configured_base_hosts() :: host_list()
  def configured_base_hosts, do: PathListConfig.configured(@spec_)

  @doc """
  Expand a store list with the project roots of any **symlinked substores**
  reachable from each store's `.felt/`.

  A project-canonical substore — say
  `~/loom/.felt/science/group/project -> .../code/project/.felt` — is
  physically rooted *outside* the store it is linked into. The poller enumerates
  a fiber only from the store where its felt `path` physically roots
  (the poller's `run_shuttle_listing/2` builds its prefix from
  `store_felt_realpath/1` below), so the loom
  store correctly drops those fibers — and they vanish from the kanban unless the
  project root is *also* a configured store. Following the symlink here makes
  configuring just `~/loom` sufficient: the project root is auto-discovered, no
  per-substore config.

  For each store, scan `<store>/.felt/` **recursively** for symlinks resolving to
  an external real `.felt/` directory and add its parent (the project root). The
  scan must recurse, not just read the top level: a store can mount substores deep
  in its tree mirror (`science/group/project`), so a shallow scan finds nothing and
  the substore silently vanishes from dispatch. Dedup is by
  `store_felt_realpath/1` — the same canonicalization the ownership check uses —
  so a store reached two ways (configured explicitly *and* discovered, or via two
  path spellings of the same real dir) is listed once. That dedup is load-bearing:
  two stores with the same `.felt` realpath would enumerate the same fibers and
  reintroduce the dispatch race the physical-rooting rule exists to prevent.
  Dangling symlinks and links resolving back inside the linking store are skipped.
  """
  @spec expand_with_symlinked_substores(host_list()) :: host_list()
  def expand_with_symlinked_substores(stores) do
    {expanded, _timings} = expand_with_timings(stores)
    expanded
  end

  # The expansion, with every store's filesystem cost attributed to it. Both
  # phases touch the disk and either can be the slow one: the substore walk
  # reaches into `<store>/.felt/`, and the dedup below `lstat`s and realpaths
  # each candidate — including the substore roots the walk just discovered,
  # which is exactly where a store in a macOS file provider sits. Timing only
  # the walk would blame the wrong store.
  @spec expand_with_timings(host_list()) :: {host_list(), %{String.t() => non_neg_integer()}}
  defp expand_with_timings(stores) do
    walked =
      Enum.map(stores, fn store ->
        {us, roots} = :timer.tc(fn -> symlinked_substore_roots(store) end)
        {store, div(us, 1000), roots}
      end)

    candidates =
      (stores ++ Enum.flat_map(walked, fn {_store, _ms, roots} -> roots end))
      |> Enum.map(&Path.expand/1)

    # When two stores share a `.felt/` realpath — a project root whose `.felt/` is
    # a real directory AND a parent (or sibling) whose own `.felt/` is a symlink
    # into it — keep the REAL-directory store. The poller's `list_shuttle_fibers/2`
    # returns `{:ok, []}` for any store whose `.felt/` is a symlink (it owns
    # nothing; the physical root is meant to enumerate). So if the dedup kept the
    # symlink store, that realpath would be enumerated by no store at all and its
    # fibers would vanish from dispatch and the kanban. Stable-sort real-`.felt`
    # stores ahead of symlink ones (Elixir's sort is stable, so order is otherwise
    # preserved); `uniq_by` then keeps the real-directory store per realpath.
    keyed =
      Enum.map(candidates, fn store ->
        {us, key} = :timer.tc(fn -> {felt_symlink?(store), store_felt_realpath(store)} end)
        {store, div(us, 1000), key}
      end)

    expanded =
      keyed
      |> Enum.sort_by(fn {_store, _ms, {symlink?, _real}} -> symlink? end)
      |> Enum.uniq_by(fn {_store, _ms, {_symlink?, real}} -> real end)
      |> Enum.map(fn {store, _ms, _key} -> store end)

    timings =
      Enum.reduce(
        Enum.map(walked, fn {s, ms, _} -> {s, ms} end) ++
          Enum.map(keyed, fn {s, ms, _} -> {s, ms} end),
        %{},
        fn {store, ms}, acc -> Map.update(acc, store, ms, &(&1 + ms)) end
      )

    {expanded, timings}
  end

  @doc """
  Realpath of `<host>/.felt`, resolving symlinks along the path so the ownership
  prefix matches felt's symlink-resolved `path`. See `Shuttle.Realpath`.

  This is the prefix both ownership checks build on — this module's
  `host_for_fiber/2` and the poller's `run_shuttle_listing/2` — so they must
  canonicalize identically or a store enumerates fibers the other drops.
  Falls back to the expanded path when resolution fails.
  """
  @spec store_felt_realpath(String.t()) :: String.t()
  def store_felt_realpath(host) do
    felt_dir = host |> Path.join(".felt") |> Path.expand()

    case Shuttle.Realpath.resolve(felt_dir) do
      {:ok, resolved} -> resolved
      {:error, _} -> felt_dir
    end
  end

  # True when `<store>/.felt` is itself a symlink rather than a real directory.
  # Such a store is skipped by the poller's enumerator, so it must lose a dedup
  # tie to a real-directory store sharing the same `.felt/` realpath.
  defp felt_symlink?(store) do
    case File.lstat(Path.join(Path.expand(store), ".felt")) do
      {:ok, %File.Stat{type: :symlink}} -> true
      _ -> false
    end
  end

  # Project roots of symlinked substores reachable under `<store>/.felt/`: every
  # entry that is a symlink resolving to a real directory named `.felt` yields
  # that `.felt`'s parent. The walk recurses into REAL subdirectories at any depth
  # (substores nest as `science/group/project`) but never follows a
  # symlink during traversal — a substore link is *detected*, not *descended*, so
  # the walk cannot loop or wander into another store's tree. A root that lands
  # back inside the linking store is dropped (the store already enumerates it).
  defp symlinked_substore_roots(store) do
    walk_substore_roots(Path.join(store, ".felt"), store_felt_realpath(store), 0)
  end

  # Real directory trees are finite (no symlink-following), so the recursion
  # terminates on its own; the depth cap is a guard against a pathologically deep
  # tree slowing the 30s-cached expansion, not a correctness boundary.
  @max_substore_scan_depth 16

  defp walk_substore_roots(_dir, _store_real, depth) when depth > @max_substore_scan_depth, do: []

  defp walk_substore_roots(dir, store_real, depth) do
    case File.ls(dir) do
      {:ok, entries} ->
        Enum.flat_map(entries, fn entry ->
          path = Path.join(dir, entry)

          case File.lstat(path) do
            # A symlink: a substore link iff it resolves to an external real
            # `.felt` directory. Detected here, never descended.
            {:ok, %File.Stat{type: :symlink}} ->
              with {:ok, real} <- Shuttle.Realpath.resolve(path),
                   ".felt" <- Path.basename(real),
                   true <- File.dir?(real),
                   false <- inside?(real, store_real) do
                [Path.dirname(real)]
              else
                _ -> []
              end

            # A real subdirectory: recurse to reach nested mount points.
            {:ok, %File.Stat{type: :directory}} ->
              walk_substore_roots(path, store_real, depth + 1)

            _ ->
              []
          end
        end)

      _ ->
        []
    end
  end

  defp inside?(path, prefix), do: path == prefix or String.starts_with?(path, prefix <> "/")

  @doc """
  Resolve which configured felt store owns `fiber_id`, as `{:ok, host}`,
  `{:error, :not_found}`, or `{:error, :timeout}`. Thin wrapper over
  `resolve_fiber/1` returning just the owning store root.
  """
  @type resolved_fiber :: %{
          host: String.t(),
          fiber_id: String.t(),
          path: String.t(),
          uid: String.t() | nil
        }

  @spec host_for_fiber(String.t()) :: {:ok, String.t()} | {:error, :not_found | :timeout}
  def host_for_fiber(fiber_id), do: host_for_fiber(fiber_id, configured_hosts())

  @spec host_for_fiber(String.t(), host_list()) ::
          {:ok, String.t()} | {:error, :not_found | :timeout}
  def host_for_fiber(fiber_id, hosts) do
    case resolve_fiber(fiber_id, hosts) do
      {:ok, %{host: host}} -> {:ok, host}
      {:error, _} = error -> error
    end
  end

  @doc """
  Resolve a public fiber identifier to the felt address Shuttle can shell out to.

  Resolution asks felt for the answer — it never reconstructs the path from the
  id. For a slug address (the common case, including the symlinked "prefix-drop"
  topology) `felt show -j <addr>` resolves the fiber and carries its physical
  `path`, addressable `id`, and intrinsic `uid` directly. For a bare intrinsic
  ULID — which `felt show` cannot address — we scan each store's `felt ls -j`
  for the matching `uid` and read the carried `path` from that row. Either way
  the values come from felt's read chokepoint, not from guessing filesystem
  layouts.

  Returns `%{host, fiber_id, path, uid}` where `host` is the owning store root
  (for shelling subsequent felt commands), `fiber_id` is felt's addressable
  slug, `path` is the absolute on-disk file, and `uid` is the intrinsic identity
  when felt carries one.

  `{:error, :timeout}` and `{:error, :not_found}` are distinct on purpose:
  a `:not_found` is felt's authoritative "no store owns this fiber", while a
  `:timeout` means a wedged store never answered — the world is UNKNOWN, and a
  caller that treated it as absence would act against the wrong store (the
  kanban's Resume falling back to a default store, a lifecycle verb 404ing a
  fiber that exists). A timeout on one store never masks a positive resolution
  from another: the scan finishes, and only an otherwise-empty result reports
  `:timeout`.
  """
  @spec resolve_fiber(String.t()) :: {:ok, resolved_fiber()} | {:error, :not_found | :timeout}
  def resolve_fiber(identifier) when is_binary(identifier),
    do: resolve_fiber(identifier, configured_hosts())

  @doc """
  As `resolve_fiber/1`, but resolves against an explicit `hosts` store list
  rather than the globally-configured stores. The Poller passes its own
  `state.felt_stores` so cold-path host resolution honors the exact store set
  that daemon instance is configured for (which may differ from the global
  `configured_hosts/0`, e.g. in tests or multi-store overrides).
  """
  @spec resolve_fiber(String.t(), host_list()) ::
          {:ok, resolved_fiber()} | {:error, :not_found | :timeout}
  def resolve_fiber(identifier, hosts) when is_binary(identifier) and is_list(hosts) do
    # `:timeout` is sticky-but-weak: it survives a miss (the world stayed
    # unknown) but loses to any positive resolution — so a wedged store never
    # masks an answer another store, or the uid scan, can still give.
    show = show_resolution(hosts, identifier)

    result =
      case show do
        %{} -> show
        _ -> uid_resolution(hosts, identifier) || show
      end

    case result do
      nil -> {:error, :not_found}
      :timeout -> {:error, :timeout}
      resolved -> {:ok, resolved}
    end
  end

  # Ask felt to resolve the address and carry the physical path, then assign
  # ownership by that path — NOT by which store happened to address it. felt's
  # JSON carries `path` (absolute, symlink-resolved), so the same physical file
  # resolves to the same path from every symlink view; the owning store is the
  # one whose realpath `.felt/` physically contains it. Re-querying felt against
  # the owner yields the owner-relative `id` (the address subsequent
  # `felt -C <owner>` commands need), instead of a symlink-view alias.
  # Returns the resolved map, `:timeout` (some store never answered and none
  # resolved — absence is not established), or nil (every store answered "not
  # mine").
  defp show_resolution(hosts, identifier) do
    Enum.reduce(hosts, nil, fn
      _host, %{} = resolved ->
        resolved

      host, acc ->
        case felt_show_json(host, identifier) do
          {:ok, %{"path" => path} = fiber} when is_binary(path) and path != "" ->
            owner = owning_store(hosts, path) || host

            owner_fiber =
              if owner == host, do: fiber, else: felt_for_path(owner, identifier, fiber)

            resolved_from(owner, owner_fiber) || acc

          {:error, :timeout} ->
            :timeout

          _ ->
            acc
        end
    end)
  end

  # `felt show` addresses fibers by slug, not by intrinsic ULID, so a bare UID
  # falls through to scanning each store's `felt ls -j` for a matching `uid`,
  # reading the carried `path`, and assigning ownership by that path. Skipped
  # entirely for non-ULID identifiers (those resolve via `show_resolution`).
  # Same nil / `:timeout` / resolved-map contract as `show_resolution/2`.
  defp uid_resolution(hosts, uid) do
    if Shuttle.ULID.valid?(uid) do
      Enum.reduce(hosts, nil, fn
        _host, %{} = resolved ->
          resolved

        host, acc ->
          case felt_ls_json(host) do
            {:ok, rows} when is_list(rows) ->
              Enum.find_value(rows, acc, fn
                %{"uid" => ^uid, "path" => path} = fiber when is_binary(path) and path != "" ->
                  owner = owning_store(hosts, path) || host
                  resolved_from(owner, fiber)

                _ ->
                  nil
              end)

            {:error, :timeout} ->
              :timeout

            _ ->
              acc
          end
      end)
    end
  end

  defp resolved_from(host, %{"id" => id, "path" => path} = fiber)
       when is_binary(id) and id != "" and is_binary(path) and path != "" do
    resolved(path, host, id, ulid_or_nil(Map.get(fiber, "uid")))
  end

  defp resolved_from(_host, _fiber), do: nil

  # The configured store that physically roots `path`: the one whose realpath
  # `.felt/` is a prefix of felt's carried (symlink-resolved) path. nil when no
  # configured store owns it (the caller keeps the queried store as a fallback).
  defp owning_store(hosts, path) do
    Enum.find(hosts, fn host ->
      String.starts_with?(path, store_felt_realpath(host) <> "/")
    end)
  end

  # Re-query the owner store so the returned `id` is owner-relative. Falls back
  # to the original fiber JSON if the owner can't address the identifier (it
  # always can for a physically-rooted fiber, but we degrade safely).
  defp felt_for_path(owner, identifier, fallback) do
    case felt_show_json(owner, identifier) do
      {:ok, %{"path" => _} = fiber} -> fiber
      _ -> fallback
    end
  end

  defp felt_show_json(host, identifier) do
    # Never fold stderr into stdout: felt prints "no felt found matching …" to
    # stderr and JSON to stdout. A miss exits non-zero with empty stdout.
    # A `:timeout` from the bounded runner is kept distinct from a miss: the
    # store never answered, so "not found" is not established.
    case runner().cmd("felt", ["-C", host, "show", identifier, "-j"], stderr_to_stdout: false) do
      {output, 0} -> Jason.decode(output)
      {_output, :timeout} -> {:error, :timeout}
      {_output, _status} -> {:error, :not_found}
    end
  rescue
    _ -> {:error, :not_found}
  end

  # `-s all` so a UID pointing at a closed/composted fiber still resolves; the
  # default `ls` filters to open/active. felt walks the tree and carries `uid`
  # and `path` per row, so no index build is required.
  defp felt_ls_json(host) do
    case runner().cmd("felt", ["-C", host, "ls", "-j", "-s", "all"], stderr_to_stdout: false) do
      {output, 0} -> Jason.decode(output)
      {_output, :timeout} -> {:error, :timeout}
      {_output, _status} -> {:error, :not_found}
    end
  rescue
    _ -> {:error, :not_found}
  end

  # The command runner, behind the same config seam as `Shuttle.Felt` — these
  # calls run from whatever process resolves a fiber (Poller, controllers), so
  # injection is by config rather than a threaded opt. Tests set
  # `:shuttle, :felt_stores_runner` to a mock; production defaults to the
  # bounded runner.
  defp runner, do: Application.get_env(:shuttle, :felt_stores_runner, Shuttle.Runner.Default)

  defp resolved(path, host, fiber_id, uid) do
    %{host: host, fiber_id: fiber_id, path: path, uid: uid}
  end

  defp ulid_or_nil(value) when is_binary(value) do
    if Shuttle.ULID.valid?(value), do: value, else: nil
  end

  defp ulid_or_nil(_), do: nil

  @spec registered_hosts() :: host_list()
  def registered_hosts, do: PathListConfig.registered(@spec_)

  @spec save(host_list()) :: {:ok, host_list()} | {:error, term()}
  def save(hosts) when is_list(hosts), do: PathListConfig.save(@spec_, hosts)

  @spec config_path() :: String.t()
  def config_path, do: PathListConfig.config_path(@spec_)

  @spec env_hosts() :: host_list()
  def env_hosts, do: PathListConfig.from_env(@spec_)

  @spec normalize(list()) :: host_list()
  def normalize(hosts), do: PathListConfig.normalize(hosts)
end
