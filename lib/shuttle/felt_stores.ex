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

  alias Shuttle.PathListConfig

  @spec_ %{
    env: "FELT_STORES",
    config_env: "FELT_STORES_FILE",
    default_path: "~/.config/felt/stores.json",
    json_key: "felt_stores"
  }

  @type host_list :: [String.t()]

  @expanded_cache_key {__MODULE__, :expanded_hosts}
  # How stale the poller lets the expansion get before re-walking it. The
  # symlink topology changes about monthly and the walk costs ~1 s on a large
  # store, so minutes of lag are free — and no request ever pays for it.
  @expansion_refresh_ms 300_000

  @doc """
  The configured stores, expanded with symlinked substores.

  A cache read — the walk runs in the poll cycle's Task
  (`refresh_expanded_hosts/0`), never on a request process. The exception is a
  cold start: the first call for a given base list, which includes a
  just-changed `FELT_STORES`/registry, so a config change takes effect at once.
  """
  @spec configured_hosts() :: host_list()
  def configured_hosts, do: cached_expansion(:infinity)

  @doc """
  Re-walk the stores for symlinked substores and publish the result for
  `configured_hosts/0` to read.

  The poller calls this from its poll Task, so the cost lands off-process on a
  cadence the daemon owns; within `@expansion_refresh_ms` of the last walk it is
  itself just a cache read.
  """
  @spec refresh_expanded_hosts() :: host_list()
  def refresh_expanded_hosts, do: cached_expansion(@expansion_refresh_ms)

  # Cached by base list, so a config change never serves the old expansion.
  # `:infinity` sorts above every integer, so the read path takes the cached
  # branch whenever an entry for this base exists.
  defp cached_expansion(max_age_ms) do
    base = configured_base_hosts()
    now = System.monotonic_time(:millisecond)

    case :persistent_term.get(@expanded_cache_key, :none) do
      {^base, expanded, walked_at} when now - walked_at < max_age_ms ->
        expanded

      _ ->
        expanded = expand_with_symlinked_substores(base)
        :persistent_term.put(@expanded_cache_key, {base, expanded, now})
        expanded
    end
  end

  @doc """
  The configured store list before symlink-substore expansion.

  This is the human-curated registry: `FELT_STORES` when explicitly set,
  otherwise the persisted `~/.config/felt/stores.json` list. Use this for picker
  surfaces that should reflect the canonical city list. Use `configured_hosts/0`
  for daemon polling/resolution, where symlinked substores must be expanded.
  """
  @spec configured_base_hosts() :: host_list()
  def configured_base_hosts, do: PathListConfig.configured(@spec_)

  # Expand a store list with the project roots of any **symlinked substores**
  # reachable from each store's `.felt/`.
  #
  # A project-canonical substore — `~/loom/.felt/science/group/project ->
  # .../code/project/.felt` — is physically rooted *outside* the store it is
  # linked into, and the poller enumerates a fiber only from the store where it
  # physically roots. Following the link makes configuring just `~/loom`
  # sufficient: the project root is auto-discovered, no per-substore config. The
  # scan recurses (substores nest as `science/group/project`, so a shallow scan
  # would silently drop them), and dedup is by `store_felt_realpath/1` — the same
  # canonicalization the ownership check uses — so a store reached two ways is
  # listed once and no two stores enumerate the same fibers. Dangling symlinks and
  # links resolving back inside the linking store are skipped.
  defp expand_with_symlinked_substores(stores) do
    discovered = Enum.flat_map(stores, &symlinked_substore_roots/1)

    (stores ++ discovered)
    |> Enum.map(&Path.expand/1)
    # When two stores share a `.felt/` realpath, keep the REAL-directory store:
    # `list_shuttle_fibers/2` returns `{:ok, []}` for a store whose `.felt/` is a
    # symlink, so keeping that one would drop the realpath from dispatch (and the
    # kanban) entirely. The sort is stable, so it only moves symlink stores last.
    |> Enum.sort_by(&felt_symlink?/1)
    |> Enum.uniq_by(&store_felt_realpath/1)
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
  # tree slowing the periodic expansion, not a correctness boundary.
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

  @spec save(host_list()) :: {:ok, host_list()} | {:error, term()}
  def save(hosts) when is_list(hosts), do: PathListConfig.save(@spec_, hosts)

end
