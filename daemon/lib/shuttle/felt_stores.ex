defmodule Shuttle.FeltStores do
  @moduledoc """
  Reads and persists felt's configured store list.

  Resolution order:

    1. `SHUTTLE_STORES` env (comma-separated)
    2. persisted registry `~/.config/shuttle/stores.json`

  The registry is the source of truth — there is no implicit default store. An
  empty env *and* an empty/absent registry resolve to `[]`; register a store
  explicitly. Saving an empty list deletes the registry file.
  """

  alias Shuttle.PathListConfig
  require Logger

  def excluded_stores,
    do: :persistent_term.get(Shuttle.Env.scope_key({__MODULE__, :excluded}), [])

  defp publish_excluded(stores) do
    stores = stores |> Enum.uniq() |> Enum.sort_by(& &1.path)
    previous = excluded_stores()

    for store <- stores, store not in previous do
      Logger.warning("Autonomous store walk excluded #{store.path}: #{store.reason}")
    end

    :persistent_term.put(Shuttle.Env.scope_key({__MODULE__, :excluded}), stores)
  end

  defp exclusion(path), do: %{path: path, reason: "protected_folder"}

  defp protected_store?(store),
    do: Shuttle.FS.protected?(store) or Shuttle.FS.protected?(store_felt_realpath(store))

  @spec_ %{
    env: "SHUTTLE_STORES",
    config_env: "SHUTTLE_STORES_FILE",
    default_path: "~/.config/shuttle/stores.json",
    json_key: "felt_stores"
  }

  @type store_list :: [String.t()]

  @expanded_cache_key {__MODULE__, :expanded_stores}
  # The poller refreshes symlink topology on this cadence. Child-process
  # discovery keeps metadata traversal outside the VM's CPU budget.
  @expansion_refresh_ms 300_000

  @doc """
  The configured stores, expanded with symlinked substores.

  A cache read — the walk runs in the poll cycle's Task
  (`refresh_expanded_stores/0`), never on a request process. The exception is a
  cold start: the first call for a given base list, which includes a
  just-changed `SHUTTLE_STORES`/registry. Discovery failures retain the last
  expansion for the same base, or the current base stores if none is cached,
  until a poll refresh.
  """
  @spec configured_stores() :: store_list()
  def configured_stores, do: cached_expansion(:infinity)

  @doc """
  Re-walk the stores for symlinked substores and publish the result for
  `configured_stores/0` to read.

  The poller calls this from its poll Task, so the cost lands off-process on a
  cadence the daemon owns; within `@expansion_refresh_ms` of the last walk it is
  itself just a cache read.
  """
  @spec refresh_expanded_stores() :: store_list()
  def refresh_expanded_stores, do: cached_expansion(@expansion_refresh_ms)

  # Cached by base list, so a config change attempts discovery immediately.
  # `:infinity` sorts above every integer, so the read path takes the cached
  # branch whenever an entry for this base exists.
  #
  # A registry that exists but cannot be read (EMFILE under load) is not an
  # empty one. Caching `[]` from such a read would make every later call see a
  # changed base and re-walk the whole tree on its request process, so the last
  # good expansion is served until a read succeeds.
  defp cached_expansion(max_age_ms) do
    now = System.monotonic_time(:millisecond)

    case {PathListConfig.read_configured(@spec_),
          :persistent_term.get(Shuttle.Env.scope_key(@expanded_cache_key), :none)} do
      {{:ok, base}, {base, expanded, walked_at}} when now - walked_at < max_age_ms ->
        expanded

      {{:error, _reason}, {_base, expanded, _walked_at}} ->
        expanded

      {{:error, _reason}, :none} ->
        []

      {{:ok, base}, cached} ->
        expanded =
          case expand_with_symlinked_substores(base) do
            {:ok, expanded, excluded} ->
              publish_excluded(excluded)
              expanded

            {:error, _reason, excluded} ->
              publish_excluded(excluded)
              Enum.reject(cached_or_base(cached, base), &protected_store?/1)
          end

        # Cache the attempt too: failed discovery retains the same base's list,
        # and only the poller's next refresh retries, never a request read.
        :persistent_term.put(Shuttle.Env.scope_key(@expanded_cache_key), {base, expanded, now})
        expanded
    end
  end

  defp cached_or_base({base, expanded, _walked_at}, base), do: expanded
  defp cached_or_base(_cached, base), do: base

  @doc """
  The configured store list before symlink-substore expansion.

  This is the human-curated registry: `SHUTTLE_STORES` when explicitly set,
  otherwise the persisted `~/.config/shuttle/stores.json` list. Use this for picker
  surfaces that should reflect the canonical city list. Use `configured_stores/0`
  for daemon polling/resolution, where symlinked substores must be expanded.
  """
  @spec configured_base_stores() :: store_list()
  def configured_base_stores, do: PathListConfig.configured(@spec_)

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
    {excluded, stores} = Enum.split_with(stores, &protected_store?/1)
    excluded = Enum.map(excluded, &exclusion/1)

    Enum.reduce_while(stores, {:ok, [], excluded}, fn store, {:ok, discovered, excluded} ->
      case symlinked_substore_roots(store) do
        {:ok, roots, skipped} -> {:cont, {:ok, discovered ++ roots, excluded ++ skipped}}
        {:error, reason} -> {:halt, {:error, reason, excluded}}
      end
    end)
    |> case do
      {:ok, discovered, excluded} ->
        {late_excluded, candidates} =
          Enum.split_with(
            Enum.map(stores ++ discovered, &Shuttle.Env.expand/1),
            &protected_store?/1
          )

        expanded =
          candidates
          # The poller skips stores whose `.felt` is a symlink. Prefer the
          # real-directory store when two stores share a `.felt` realpath.
          |> Enum.sort_by(&felt_symlink?/1)
          |> Enum.uniq_by(&store_felt_realpath/1)

        {:ok, expanded, excluded ++ Enum.map(late_excluded, &exclusion/1)}

      {:error, _reason, _excluded} = error ->
        error
    end
  end

  @doc """
  Realpath of `<store>/.felt`, resolving symlinks along the path so the ownership
  prefix matches felt's symlink-resolved `path`. See `Shuttle.Realpath`.

  This is the prefix both ownership checks build on — this module's
  `store_for_fiber/2` and the poller's `run_shuttle_listing/2` — so they must
  canonicalize identically or a store enumerates fibers the other drops.
  Falls back to the expanded path when resolution fails.
  """
  @spec store_felt_realpath(String.t()) :: String.t()
  def store_felt_realpath(store) do
    felt_dir = store |> Path.join(".felt") |> Shuttle.Env.expand()

    case Shuttle.Realpath.resolve(felt_dir) do
      {:ok, resolved} -> resolved
      {:error, _} -> felt_dir
    end
  end

  # True when `<store>/.felt` is itself a symlink rather than a real directory.
  # Such a store is skipped by the poller's enumerator, so it must lose a dedup
  # tie to a real-directory store sharing the same `.felt/` realpath.
  defp felt_symlink?(store) do
    case Shuttle.FS.lstat(Path.join(Shuttle.Env.expand(store), ".felt")) do
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
  # Entries in directories at depth 0..16 are inspected, so links at find
  # depth 17 are included. The cap bounds traversal of pathological trees.
  @max_substore_scan_depth 16
  @substore_scan_timeout_ms 60_000
  @substore_scan_max_output_bytes 4 * 1024 * 1024

  defp symlinked_substore_roots(store) do
    store_real = store_felt_realpath(store)

    # Resolve the starting directory so a configured symlink-.felt view is
    # scanned too. -P never follows any symlink encountered within that tree.
    # find uses directory-entry types where available; per-entry metadata work
    # stays in the child even on filesystems that require stat fallbacks.
    args = [
      "-P",
      store_real,
      "-maxdepth",
      Integer.to_string(@max_substore_scan_depth + 1),
      "-type",
      "l",
      "-print0"
    ]

    case if(Shuttle.FS.protected?(store_real),
           do: {"", 0},
           else: substore_links(store_real, args)
         ) do
      {output, 0} ->
        {roots, skipped} =
          output
          |> String.split(<<0>>, trim: true)
          |> Enum.reduce({[], []}, fn path, {roots, skipped} ->
            case Shuttle.Realpath.resolve(path) do
              {:ok, real} ->
                cond do
                  Path.basename(real) != ".felt" ->
                    {roots, skipped}

                  Shuttle.FS.protected?(real) ->
                    {roots, [exclusion(path) | skipped]}

                  not inside?(real, store_real) and Shuttle.FS.dir?(real) ->
                    {[Path.dirname(real) | roots], skipped}

                  true ->
                    {roots, skipped}
                end

              {:error, _} ->
                {roots, skipped}
            end
          end)

        {:ok, Enum.reverse(roots), skipped}

      {_output, status} ->
        {:error, status}
    end
  end

  # An absent `.felt` has no links. Check only the root, never each entry;
  # other filesystem errors remain discovery failures rather than empty scans.
  defp substore_links(dir, args) do
    case Shuttle.FS.stat(dir) do
      {:error, reason} when reason in [:enoent, :enotdir] ->
        {"", 0}

      {:ok, %File.Stat{type: :directory}} ->
        runner().cmd("find", args,
          stderr_to_stdout: false,
          timeout_ms: @substore_scan_timeout_ms,
          max_output_bytes: @substore_scan_max_output_bytes
        )

      {:ok, _stat} ->
        {"", 0}

      {:error, reason} ->
        {"", reason}
    end
  rescue
    # Port launch resource failures are unknown discovery, not an empty tree.
    # Keep the same fallback and retry cadence as a failed child process.
    error in [ErlangError, SystemLimitError, ArgumentError] ->
      {Exception.message(error), :launch_failed}
  end

  defp inside?(path, prefix), do: path == prefix or String.starts_with?(path, prefix <> "/")

  @doc """
  Resolve which configured felt store owns `fiber_id`, as `{:ok, store}`,
  `{:error, :not_found}`, or `{:error, :timeout}`. Thin wrapper over
  `resolve_fiber/1` returning just the owning store root.
  """
  @type resolved_fiber :: %{
          store: String.t(),
          fiber_id: String.t(),
          path: String.t(),
          uid: String.t() | nil
        }

  @spec store_for_fiber(String.t()) :: {:ok, String.t()} | {:error, :not_found | :timeout}
  def store_for_fiber(fiber_id), do: store_for_fiber(fiber_id, configured_stores())

  @spec store_for_fiber(String.t(), store_list()) ::
          {:ok, String.t()} | {:error, :not_found | :timeout}
  def store_for_fiber(fiber_id, stores) do
    case resolve_fiber(fiber_id, stores) do
      {:ok, %{store: store}} -> {:ok, store}
      {:error, _} = error -> error
    end
  end

  @doc """
  Resolve a public fiber identifier to the felt address Shuttle can shell out to.

  Resolution asks `felt show -j` for the physical `path`, namespace-relative
  `id`, and intrinsic `uid`.
  Paths and ULIDs use `--exact`, so an absent path cannot resolve to a same-leaf
  fiber elsewhere in the store.
  Bare names on the read surface retain felt's interactive name resolution.
  Lifecycle requests use `resolve_request/1`, which is exact for every identifier.

  Returns `%{store, fiber_id, path, uid}` where `store` is the owning store root
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
    do: resolve_fiber(identifier, configured_stores())

  @doc """
  `resolve_fiber/1` with its failures mapped into the CLI-result error
  vocabulary the lifecycle and felt-edit surfaces render.

  One definition of those two sentences: the daemon renders the same
  "fiber not found" / "felt timed out resolving" pair everywhere it resolves a
  fiber for a caller, and `:timeout` keeps its distinct three-tuple shape so a
  wedged store is never reported as absence.
  """
  @spec resolve_fiber_or_error(String.t()) ::
          {:ok, resolved_fiber()} | {:error, String.t()} | {:error, :timeout, String.t()}
  def resolve_fiber_or_error(identifier) when is_binary(identifier) do
    case resolve_fiber(identifier) do
      {:ok, resolved} -> {:ok, resolved}
      {:error, :not_found} -> {:error, "fiber not found: #{identifier}"}
      {:error, :timeout} -> {:error, :timeout, "felt timed out resolving #{identifier}"}
      {:error, reason} -> {:error, "felt failed resolving #{identifier}: #{inspect(reason)}"}
    end
  end

  @doc "Resolve an exact namespace path or intrinsic UID for a lifecycle write."
  def resolve_request(identifier) do
    case resolve_with(identifier, configured_stores(), true) do
      {:ok, resolved} -> {:ok, resolved}
      {:error, :not_found} -> {:error, :not_found, missing_on_host(identifier)}
      {:error, :timeout} -> {:error, :timeout, "felt timed out resolving #{identifier}"}
      {:error, reason} -> {:error, "felt failed resolving #{identifier}: #{inspect(reason)}"}
    end
  end

  def missing_on_host(identifier),
    do: "fiber not found on #{Shuttle.Poller.own_host_id()}: #{identifier}"

  @doc """
  As `resolve_fiber/1`, but resolves against an explicit `stores` list
  rather than the globally-configured stores. The Poller passes its own
  `state.felt_stores` so cold-path store resolution honors the exact store set
  that daemon instance is configured for (which may differ from the global
  `configured_stores/0`, e.g. in tests or multi-store overrides).
  """
  @spec resolve_fiber(String.t(), store_list()) ::
          {:ok, resolved_fiber()} | {:error, :not_found | :timeout}
  def resolve_fiber(identifier, stores) when is_binary(identifier) and is_list(stores) do
    exact = String.contains?(identifier, "/") or Shuttle.ULID.valid?(identifier)
    resolve_with(identifier, stores, exact)
  end

  defp resolve_with(identifier, stores, exact) do
    case show_resolution(stores, identifier, exact) do
      nil -> {:error, :not_found}
      :timeout -> {:error, :timeout}
      {:error, _} = error -> error
      resolved -> {:ok, resolved}
    end
  end

  # Ask felt to resolve the address and carry the physical path, then assign
  # ownership by that path — NOT by which store happened to address it. felt's
  # JSON carries `path` (absolute, symlink-resolved), so the same physical file
  # resolves to the same path from every symlink view; the owning store is the
  # one whose realpath `.felt/` physically contains it. The carried physical
  # path yields the owner-relative `id` that subsequent writes need, rather
  # than a symlink-view alias.
  # Returns the resolved map, `:timeout` (some store never answered and none
  # resolved — absence is not established), or nil (every store answered "not
  # mine").
  defp show_resolution(stores, identifier, exact) do
    Enum.reduce(stores, nil, fn
      _host, %{} = resolved ->
        resolved

      store, acc ->
        case felt_show_json(store, identifier, exact) do
          {:ok, %{"path" => path} = fiber} when is_binary(path) and path != "" ->
            owner = owning_store(stores, path) || namespace_store(store)

            resolved_from(owner, felt_for_path(owner, fiber)) || acc

          {:error, :timeout} ->
            :timeout

          {:error, :not_found} ->
            acc

          {:error, reason} ->
            {:error, reason}
        end
    end)
  end

  defp resolved_from(store, %{"id" => id, "path" => path} = fiber)
       when is_binary(id) and id != "" and is_binary(path) and path != "" do
    resolved(path, store, id, ulid_or_nil(Map.get(fiber, "uid")))
  end

  defp resolved_from(_host, _fiber), do: nil

  # The configured store that physically roots `path`: the one whose realpath
  # `.felt/` is a prefix of felt's carried (symlink-resolved) path. nil when no
  # configured store owns it (the caller keeps the queried store as a fallback).
  defp owning_store(stores, path) do
    case Enum.find(stores, fn store ->
           String.starts_with?(path, store_felt_realpath(store) <> "/")
         end) do
      nil -> nil
      store -> namespace_store(store)
    end
  end

  @doc "The enclosing namespace root used for exact fiber reads and writes."
  @spec namespace_store(String.t()) :: String.t()
  def namespace_store(store) do
    root = store_felt_realpath(store)

    if Path.basename(root) == ".felt" do
      store
    else
      case enclosing_felt(root) do
        nil -> store
        felt -> Path.dirname(felt)
      end
    end
  end

  defp enclosing_felt(path) do
    parent = Path.dirname(path)

    cond do
      Path.basename(path) == ".felt" -> path
      parent == path -> nil
      true -> enclosing_felt(parent)
    end
  end

  # The physical path carries the owner-relative address even without a UID.
  # Re-resolving a view's id in another store can select a different document.
  defp felt_for_path(owner, fiber) do
    relative = Path.relative_to(fiber["path"], store_felt_realpath(owner))
    leaf = relative |> Path.basename() |> Path.rootname()
    parent = Path.dirname(relative)
    id = if Path.basename(parent) == leaf, do: parent, else: Path.rootname(relative)
    Map.put(fiber, "id", id)
  end

  defp felt_show_json(store, identifier, exact) do
    # JSON error codes distinguish authoritative absence from ambiguity,
    # unreadable stores and a CLI that does not implement this protocol.
    args = ["-C", store, "show", identifier, "-j"]
    args = if exact, do: args ++ ["--exact"], else: args

    case runner().cmd("felt", args, stderr_to_stdout: false) do
      {output, 0} ->
        Jason.decode(output)

      {_output, :timeout} ->
        {:error, :timeout}

      {output, status} ->
        case Jason.decode(output) do
          {:ok, %{"error_code" => "not_found"}} ->
            {:error, :not_found}

          {:ok, %{"error" => message}} ->
            {:error, {:resolution_failed, message}}

          _ ->
            {:error,
             {:resolution_failed, "felt show exited #{inspect(status)}: #{String.trim(output)}"}}
        end
    end
  rescue
    error -> {:error, {:resolution_failed, Exception.message(error)}}
  end

  # The command runner, behind the same config seam as `Shuttle.Felt` — these
  # calls discover substores or resolve fibers (Poller, controllers), so
  # injection is by config rather than a threaded opt. Tests set
  # `:shuttle, :felt_stores_runner` to a mock; production defaults to the
  # bounded runner.
  defp runner, do: Shuttle.Env.app(:felt_stores_runner, Shuttle.Runner.Default)

  defp resolved(path, store, fiber_id, uid) do
    %{store: store, fiber_id: fiber_id, path: path, uid: uid}
  end

  defp ulid_or_nil(value) when is_binary(value) do
    if Shuttle.ULID.valid?(value), do: value, else: nil
  end

  defp ulid_or_nil(_), do: nil

  @spec save(store_list()) :: {:ok, store_list()} | {:error, term()}
  def save(stores) when is_list(stores), do: PathListConfig.save(@spec_, stores)

  @doc """
  Where the registry file resolves: `SHUTTLE_STORES_FILE`, else
  `~/.config/shuttle/stores.json`. `SHUTTLE_STORES` overrides the file's *contents*,
  not its location, so this path can be live and unread at the same time.
  """
  @spec config_path() :: String.t()
  def config_path, do: PathListConfig.config_path(@spec_)

  @doc """
  The list PERSISTED in the file, ignoring `SHUTTLE_STORES`.

  Distinct from `configured_base_stores/0`, which answers "what is this daemon
  actually polling" — the env form when it is set. An editor of the file wants
  the file: showing the env list in a control that writes the file would let
  someone save the override's contents into a file nobody reads.
  """
  @spec registered_stores() :: store_list()
  def registered_stores, do: PathListConfig.registered(@spec_)
end
