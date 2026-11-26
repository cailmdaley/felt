defmodule Shuttle.MapTerrain do
  @moduledoc """
  Builds and caches the Fleet Map terrain payload (`GET /api/v1/map/terrain`).

  Scans configured base felt stores via `shuttle ls`, filters out
  `.gitignore`-matched paths and optional `exclude` entries from
  `~/.config/shuttle/map.json` in pure Elixir (never invoking `git`), overlays
  live cross-host worker state from the Poller and `Shuttle.RemoteFiberRegistry`,
  and aggregates fibers, wikilinks, and constitutions into continents, areas,
  links, and cities.

  Cached in the named ETS table `:shuttle_map_terrain_cache` with a 120 s TTL
  and stale-while-revalidate background refresh.
  """

  require Logger

  alias Shuttle.{CLI, Env, FeltStores, FS, Lifecycle, Lock, Poller, Realpath, RemoteFiberRegistry}

  @table :shuttle_map_terrain_cache
  @ttl_ms 120_000
  @ls_timeout_ms 30_000
  @day_ms 86_400_000
  @json_fields "id,uid,name,status,tempered,shuttle,role,seat,created_at,modified_at,horizon,tags,report_path,inputs,depends_on"
  @ulid_re ~r/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i
  @ulid_alphabet "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
  @base_guild MapSet.new(["roles", "practices", "commons"])
  @default_display %{"guild" => "Guild & Commons", "shoals" => "Unfiled Shoals"}
  @frontmatter_re ~r/\A---\s*\r?\n(.*?)\r?\n---\s*(?:\r?\n|\z)/s
  @fenced_code_re ~r/^\s*(```+|~~~+)[^\n]*\n[\s\S]*?^\s*\1[^\n]*(?:\n|$)/m
  @inline_code_re ~r/`[^`\n]*`/
  @wikilink_re ~r/\[\[([^\]\n]+)\]\]/
  @max_nested_substore_depth 4

  @doc false
  def init_cache do
    case :ets.whereis(@table) do
      :undefined ->
        try do
          :ets.new(@table, [:named_table, :public, :set, read_concurrency: true])
        rescue
          ArgumentError -> @table
        end

      _tid ->
        @table
    end
  end

  @doc """
  Return the cached terrain payload.

  - Fresh (`age < 120s`): returns `{:ok, payload}` immediately.
  - Stale (`age >= 120s`): returns `{:ok, stale_payload}` immediately and spawns
    a coalesced background refresh task to update the ETS entry.
  - Cold miss: builds synchronously behind `Shuttle.Lock`.
  """
  @spec fetch(keyword()) :: {:ok, map()} | {:error, term()}
  def fetch(opts \\ []) do
    key = cache_key()
    ttl_ms = Keyword.get(opts, :ttl_ms, @ttl_ms)
    mono_now = Keyword.get_lazy(opts, :monotonic_ms, fn -> System.monotonic_time(:millisecond) end)

    case lookup_cache(key, mono_now, ttl_ms) do
      {:fresh, payload} ->
        {:ok, payload}

      {:stale, payload} ->
        maybe_refresh_async(key, opts, ttl_ms)
        {:ok, payload}

      :miss ->
        Lock.transaction({__MODULE__, key}, fn ->
          now_inside =
            Keyword.get_lazy(opts, :monotonic_ms, fn -> System.monotonic_time(:millisecond) end)

          case lookup_cache(key, now_inside, ttl_ms) do
            {:fresh, payload} ->
              {:ok, payload}

            {:stale, payload} ->
              maybe_refresh_async(key, opts, ttl_ms)
              {:ok, payload}

            :miss ->
              case build(opts) do
                {:ok, payload} ->
                  put_cache(key, now_inside, payload)
                  {:ok, payload}

                error ->
                  error
              end
          end
        end)
    end
  end

  @doc "Clear the scoped terrain cache."
  @spec clear_cache() :: :ok
  def clear_cache do
    key = cache_key()

    try do
      :ets.delete(@table, key)
      :ets.delete(@table, {:inflight, key})
    rescue
      ArgumentError -> :ok
    end

    :ok
  end

  @doc "Build a fresh terrain payload without reading or writing the cache."
  @spec build(keyword()) :: {:ok, map()} | {:error, term()}
  def build(opts \\ []) do
    now_dt = Keyword.get_lazy(opts, :now, &DateTime.utc_now/0)
    now_ms = DateTime.to_unix(now_dt, :millisecond)
    config = Keyword.get_lazy(opts, :map_config, &load_map_config/0)
    excludes = config |> Map.get(:exclude, []) |> normalize_excludes()
    stores = Keyword.get_lazy(opts, :stores, &active_base_stores/0)

    {live_by_uid, origins} =
      Keyword.get_lazy(opts, :composite, fn -> load_composite(now_ms) end)

    with {:ok, {all_rows, candidates, mount_prefixes}} <- collect_stores(stores, excludes, opts) do
      allowed =
        candidates
        |> Enum.uniq_by(& &1.file)
        |> Enum.sort_by(& &1.row["id"])

      payload =
        assemble(
          all_rows,
          allowed,
          mount_prefixes,
          excludes,
          live_by_uid,
          origins,
          config,
          now_dt,
          now_ms
        )

      {:ok, payload}
    end
  end

  # ── Cache ──

  defp cache_key, do: Env.scope_key({__MODULE__, :cache})

  defp lookup_cache(key, mono_now, ttl_ms) do
    case :ets.lookup(@table, key) do
      [{^key, ts, payload}] when is_integer(ts) ->
        if mono_now - ts < ttl_ms, do: {:fresh, payload}, else: {:stale, payload}

      _ ->
        :miss
    end
  rescue
    ArgumentError -> :miss
  end

  defp put_cache(key, ts, payload) do
    :ets.insert(@table, {key, ts, payload})
    :ok
  rescue
    ArgumentError -> :ok
  end

  defp claim_inflight(key) do
    :ets.insert_new(@table, {{:inflight, key}, true})
  rescue
    ArgumentError -> false
  end

  defp clear_inflight(key) do
    :ets.delete(@table, {:inflight, key})
    :ok
  rescue
    ArgumentError -> :ok
  end

  defp maybe_refresh_async(key, opts, ttl_ms) do
    if claim_inflight(key) do
      callers = Env.callers()
      on_refresh = Keyword.get(opts, :on_refresh)

      Task.start(fn ->
        Env.adopt_callers(callers)

        try do
          Lock.transaction({__MODULE__, key}, fn ->
            now_inside =
              Keyword.get_lazy(opts, :monotonic_ms, fn ->
                System.monotonic_time(:millisecond)
              end)

            case lookup_cache(key, now_inside, ttl_ms) do
              {:fresh, _payload} ->
                :ok

              _ ->
                case build(opts) do
                  {:ok, payload} ->
                    put_cache(key, now_inside, payload)

                  {:error, reason} ->
                    Logger.warning(
                      "Shuttle.MapTerrain: background refresh failed: #{inspect(reason)}"
                    )
                end
            end
          end)
        after
          clear_inflight(key)
          if is_function(on_refresh, 0), do: on_refresh.()
        end
      end)
    end

    :ok
  end

  # ── Optional map.json config ──

  defp map_config_path do
    case Env.get("SHUTTLE_MAP_CONFIG") do
      path when is_binary(path) and path != "" -> Env.expand(path)
      _ -> Env.expand("~/.config/shuttle/map.json")
    end
  end

  defp load_map_config do
    empty = %{
      merge: %{},
      display: %{},
      seas: %{},
      pins: %{},
      shared_rollup: nil,
      exclude: [],
      guild_roots: []
    }

    path = map_config_path()

    case FS.read(path) do
      {:ok, content} ->
        case Jason.decode(content) do
          {:ok, map} when is_map(map) ->
            %{
              merge: string_map(map["merge"]),
              display: string_map(map["display"]),
              seas: map_or_empty(map["seas"]),
              pins: map_or_empty(map["pins"]),
              shared_rollup: parse_shared_rollup(map["shared_rollup"]),
              exclude: normalize_excludes(map["exclude"]),
              guild_roots: string_list(map["guild_roots"])
            }

          _ ->
            Logger.warning("Shuttle.MapTerrain: ignoring malformed JSON in #{path}")
            empty
        end

      {:error, :enoent} ->
        empty

      {:error, reason} ->
        Logger.warning("Shuttle.MapTerrain: cannot read #{path}: #{inspect(reason)}")
        empty
    end
  end

  defp string_map(map) when is_map(map) do
    for {k, v} <- map, is_binary(k) and is_binary(v), into: %{}, do: {k, v}
  end

  defp string_map(_), do: %{}

  defp string_list(list) when is_list(list) do
    list
    |> Enum.filter(&is_binary/1)
    |> Enum.map(&(&1 |> String.trim() |> String.trim("/")))
    |> Enum.reject(&(&1 == ""))
    |> Enum.uniq()
  end

  defp string_list(_), do: []

  defp normalize_excludes(list) when is_list(list) do
    list
    |> Enum.filter(&is_binary/1)
    |> Enum.map(&(&1 |> String.trim() |> String.trim("/") |> String.downcase()))
    |> Enum.reject(&(&1 == ""))
    |> Enum.uniq()
  end

  defp normalize_excludes(_), do: []

  defp map_or_empty(map) when is_map(map), do: map
  defp map_or_empty(_), do: %{}

  defp parse_shared_rollup(%{"mount" => mount, "target" => target} = cfg)
       when is_binary(mount) and mount != "" and is_binary(target) and target != "" do
    max_cities =
      case cfg["max_cities"] do
        n when is_integer(n) and n >= 0 -> n
        _ -> 2
      end

    %{mount: String.trim_trailing(mount, "/"), target: target, max_cities: max_cities}
  end

  defp parse_shared_rollup(_), do: nil

  # ── Store enumeration & allowlisting ──

  defp active_base_stores do
    FeltStores.configured_base_stores()
    |> Enum.map(&Env.expand/1)
    |> Enum.reject(fn store ->
      FS.protected?(store) or FS.protected?(FeltStores.store_felt_realpath(store))
    end)
    |> Enum.uniq_by(&FeltStores.store_felt_realpath/1)
  end

  defp collect_stores(stores, excludes, opts) do
    cli_opts =
      [timeout_ms: @ls_timeout_ms, stderr_to_stdout: false] ++
        if(opts[:runner], do: [runner: opts[:runner]], else: [])

    {rows, cands, mounts, ok_count, last_error} =
      Enum.reduce(stores, {[], [], MapSet.new(), 0, nil}, fn store,
                                                             {rows_acc, cand_acc, mounts_acc, ok_n,
                                                              err_acc} ->
        expanded = Env.expand(store)

        if FS.protected?(expanded) or FS.protected?(FeltStores.store_felt_realpath(expanded)) do
          {rows_acc, cand_acc, mounts_acc, ok_n, err_acc}
        else
          case list_store(expanded, cli_opts) do
            {:ok, rows} ->
              {base_ctx, substores} = inspect_store(expanded, excludes)
              top_mounts = for s <- substores, s.top_level?, into: MapSet.new(), do: s.mount

              candidates =
                Enum.reduce(rows, [], fn row, acc ->
                  case allowlist_row(row, base_ctx, substores, excludes) do
                    {:ok, candidate} -> [candidate | acc]
                    :skip -> acc
                  end
                end)

              {rows_acc ++ rows, cand_acc ++ Enum.reverse(candidates),
               MapSet.union(mounts_acc, top_mounts), ok_n + 1, err_acc}

            {:error, reason} ->
              Logger.warning("Shuttle.MapTerrain: skipping store #{expanded}: #{inspect(reason)}")
              {rows_acc, cand_acc, mounts_acc, ok_n, reason}
          end
        end
      end)

    if ok_count == 0 and last_error != nil do
      {:error, last_error}
    else
      {:ok, {rows, cands, mounts}}
    end
  end

  defp list_store(store, cli_opts) do
    args = ["-C", store, "ls", "--json", "-s", "all", "--json-field", @json_fields]

    case CLI.run(args, cli_opts) do
      {:ok, output} ->
        case Jason.decode(output) do
          {:ok, rows} when is_list(rows) -> {:ok, rows}
          {:ok, _} -> {:error, :unexpected_json_shape}
          {:error, reason} -> {:error, {:invalid_json, reason}}
        end

      {:command_error, status, output} ->
        {:error, {:command_error, status, String.slice(output, 0, 200)}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp inspect_store(store, excludes) do
    felt_real = FeltStores.store_felt_realpath(store)
    repo_root = repo_root_for(felt_real)

    base_ctx = %{
      store_name: Path.basename(repo_root),
      felt_real: felt_real,
      repo_root: repo_root,
      repo_rules: load_gitignore(Path.join(repo_root, ".gitignore")),
      felt_rules: load_gitignore(Path.join(felt_real, ".gitignore")),
      shared?: false
    }

    substores = discover_substores(felt_real, felt_real, "", 0, excludes)
    {base_ctx, substores}
  end

  defp repo_root_for(felt_real) do
    if Path.basename(felt_real) == ".felt", do: Path.dirname(felt_real), else: felt_real
  end

  # Top-level symlinks under `<store>/.felt/` are mounted shared substores
  # (`shared?: true`). Deeper symlinks resolving to a `.felt` directory are
  # project substores (`shared?: false`). Neither follows symlinks while walking.
  defp discover_substores(dir, store_felt_real, prefix, depth, excludes)
       when depth < @max_nested_substore_depth do
    case FS.ls(dir) do
      {:ok, names} ->
        Enum.flat_map(names, fn name ->
          rel = if prefix == "", do: name, else: prefix <> "/" <> name

          cond do
            String.starts_with?(name, ".") or excluded?(rel, excludes) ->
              []

            true ->
              full = Path.join(dir, name)

              case FS.lstat(full) do
                {:ok, %File.Stat{type: :symlink}} ->
                  maybe_substore(full, rel, store_felt_real, depth == 0)

                {:ok, %File.Stat{type: :directory}} ->
                  discover_substores(full, store_felt_real, rel, depth + 1, excludes)

                _ ->
                  []
              end
          end
        end)

      {:error, _} ->
        []
    end
  end

  defp discover_substores(_dir, _store_felt_real, _prefix, _depth, _excludes), do: []

  defp maybe_substore(link_path, mount_rel, store_felt_real, top_level?) do
    with {:ok, real} <- Realpath.resolve(link_path),
         true <- FS.dir?(real),
         false <- FS.protected?(real),
         false <- inside?(real, store_felt_real),
         true <- top_level? or Path.basename(real) == ".felt" do
      repo_root = repo_root_for(real)

      [
        %{
          mount: mount_rel,
          store_name: if(top_level?, do: mount_rel, else: Path.basename(repo_root)),
          felt_real: real,
          repo_root: repo_root,
          repo_rules: load_gitignore(Path.join(repo_root, ".gitignore")),
          felt_rules:
            if(real == repo_root, do: [], else: load_gitignore(Path.join(real, ".gitignore"))),
          shared?: top_level?,
          top_level?: top_level?
        }
      ]
    else
      _ -> []
    end
  end

  defp allowlist_row(%{"id" => id} = row, base_ctx, substores, excludes)
       when is_binary(id) and id != "" do
    parts = String.split(id, "/")

    cond do
      excluded?(id, excludes) ->
        :skip

      Enum.any?(parts, &(&1 in ["", ".", ".."])) ->
        :skip

      true ->
        with {:ok, path} <- locate_fiber_file(base_ctx.felt_real, id),
             {:ok, real} <- Realpath.resolve(path),
             {:ok, owner} <- owning_context(real, base_ctx, substores),
             rel_repo <- Path.relative_to(real, owner.repo_root),
             rel_felt <- Path.relative_to(real, owner.felt_real),
             false <- excluded?(rel_repo, excludes),
             false <- excluded?(rel_felt, excludes),
             false <- ignored?(rel_repo, owner.repo_rules),
             false <- ignored?(rel_felt, owner.felt_rules) do
          {:ok,
           %{
             row: row,
             file: real,
             store_name: owner.store_name,
             shared?: owner.shared?
           }}
        else
          _ -> :skip
        end
    end
  end

  defp allowlist_row(_row, _base_ctx, _substores, _excludes), do: :skip

  defp locate_fiber_file(felt_real, id) do
    leaf = Path.basename(id)
    folder_file = Path.join([felt_real, id, leaf <> ".md"])
    flat_file = Path.join(felt_real, id <> ".md")

    cond do
      FS.regular?(folder_file) -> {:ok, folder_file}
      FS.regular?(flat_file) -> {:ok, flat_file}
      true -> :error
    end
  end

  defp owning_context(real, base_ctx, substores) do
    case Enum.find(substores, &inside?(real, &1.felt_real)) do
      nil ->
        if inside?(real, base_ctx.felt_real), do: {:ok, base_ctx}, else: :error

      sub ->
        {:ok, sub}
    end
  end

  defp inside?(path, prefix), do: path == prefix or String.starts_with?(path, prefix <> "/")

  defp excluded?(_path, []), do: false

  defp excluded?(path, excludes) when is_binary(path) do
    haystack = "/" <> (path |> String.trim("/") |> String.downcase()) <> "/"
    Enum.any?(excludes, &String.contains?(haystack, "/" <> &1 <> "/"))
  end

  defp excluded?(_, _), do: false

  # ── Pure-Elixir .gitignore matching ──

  @doc false
  def load_gitignore(path) do
    case FS.read(path) do
      {:ok, content} -> parse_gitignore(content)
      {:error, _} -> []
    end
  end

  @doc false
  def parse_gitignore(content) when is_binary(content) do
    content
    |> String.split("\n")
    |> Enum.reduce([], fn raw_line, acc ->
      line = raw_line |> String.trim_trailing("\r") |> strip_trailing_unescaped_spaces()

      cond do
        line == "" or String.starts_with?(line, "#") ->
          acc

        true ->
          {negated?, rest} =
            case line do
              "!" <> r -> {true, r}
              "\\!" <> r -> {false, "!" <> r}
              "\\#" <> r -> {false, "#" <> r}
              other -> {false, other}
            end

          {dir_only?, pattern} =
            if String.ends_with?(rest, "/") do
              {true, String.trim_trailing(rest, "/")}
            else
              {false, rest}
            end

          if pattern == "" do
            acc
          else
            {anchored?, normalized} =
              case pattern do
                "/" <> r -> {true, r}
                r -> {String.contains?(r, "/"), r}
              end

            case compile_gitignore_glob(normalized) do
              {:ok, regex} ->
                [
                  %{
                    negated?: negated?,
                    dir_only?: dir_only?,
                    anchored?: anchored?,
                    regex: regex
                  }
                  | acc
                ]

              {:error, reason} ->
                Logger.warning(
                  "Shuttle.MapTerrain: failed to compile .gitignore pattern #{inspect(line)} (#{inspect(reason)}); failing closed"
                )

                if negated? do
                  acc
                else
                  [
                    %{
                      negated?: false,
                      dir_only?: false,
                      anchored?: false,
                      regex: ~r/\A.*\z/s
                    }
                    | acc
                  ]
                end
            end
          end
      end
    end)
    |> Enum.reverse()
  end

  @doc false
  def ignored?(_rel_path, []), do: false

  def ignored?(rel_path, rules) when is_binary(rel_path) and is_list(rules) do
    normalized = String.trim_leading(rel_path, "/")
    dirs = ancestor_dirs(normalized)

    if Enum.any?(dirs, &path_ignored?(&1, true, rules)) do
      true
    else
      path_ignored?(normalized, false, rules)
    end
  end

  defp path_ignored?(path, is_dir?, rules) do
    basename = Path.basename(path)

    Enum.reduce(rules, false, fn rule, ignored_so_far ->
      if rule.dir_only? and not is_dir? do
        ignored_so_far
      else
        target = if rule.anchored?, do: path, else: basename

        if Regex.match?(rule.regex, target) do
          not rule.negated?
        else
          ignored_so_far
        end
      end
    end)
  end

  defp ancestor_dirs(rel_path) do
    case String.split(rel_path, "/") do
      [_file] ->
        []

      parts ->
        parts
        |> Enum.drop(-1)
        |> Enum.scan(fn seg, acc -> acc <> "/" <> seg end)
    end
  end

  defp strip_trailing_unescaped_spaces(line) do
    case Regex.run(~r/^(.*?)(\s+)$/, line) do
      [_, prefix, _spaces] ->
        if String.ends_with?(prefix, "\\") do
          line
        else
          prefix
        end

      _ ->
        line
    end
  end

  defp compile_gitignore_glob(pattern) do
    regex_str = "\\A" <> glob_to_regex(pattern) <> "\\z"

    case Regex.compile(regex_str) do
      {:ok, regex} -> {:ok, regex}
      {:error, reason} -> {:error, reason}
    end
  end

  defp glob_to_regex(pattern), do: glob_chars(pattern, [])

  defp glob_chars("", acc), do: acc |> Enum.reverse() |> IO.iodata_to_binary()
  defp glob_chars("**/" <> rest, acc), do: glob_chars(rest, ["(?:.*/)?" | acc])
  defp glob_chars("/**" <> rest, acc), do: glob_chars(rest, ["(?:/.*)?" | acc])
  defp glob_chars("**" <> rest, acc), do: glob_chars(rest, [".*" | acc])
  defp glob_chars("*" <> rest, acc), do: glob_chars(rest, ["[^/]*" | acc])
  defp glob_chars("?" <> rest, acc), do: glob_chars(rest, ["[^/]" | acc])

  defp glob_chars("\\" <> <<c::utf8, rest::binary>>, acc) do
    glob_chars(rest, [Regex.escape(<<c::utf8>>) | acc])
  end

  defp glob_chars("[" <> rest, acc) do
    case parse_char_class(rest) do
      {:ok, class_regex, remaining} -> glob_chars(remaining, [class_regex | acc])
      :error -> glob_chars(rest, ["\\[" | acc])
    end
  end

  defp glob_chars(<<c::utf8, rest::binary>>, acc) do
    glob_chars(rest, [Regex.escape(<<c::utf8>>) | acc])
  end

  defp parse_char_class(str) do
    {negated, after_neg} =
      case str do
        "!" <> r -> {"^", r}
        "^" <> r -> {"^", r}
        r -> {"", r}
      end

    {initial_items, scan_str} =
      case after_neg do
        "]" <> r -> {[{:escaped, "]"}], r}
        r -> {[], r}
      end

    case scan_char_class(scan_str, initial_items) do
      {:ok, [], _remaining} ->
        :error

      {:ok, items, remaining} ->
        body = items |> Enum.reverse() |> format_class_items([])
        {:ok, "[" <> negated <> body <> "]", remaining}

      :error ->
        :error
    end
  end

  defp scan_char_class("", _acc), do: :error
  defp scan_char_class("]" <> rest, acc), do: {:ok, acc, rest}

  defp scan_char_class("\\" <> <<c::utf8, rest::binary>>, acc),
    do: scan_char_class(rest, [{:escaped, <<c::utf8>>} | acc])

  defp scan_char_class(<<c::utf8, rest::binary>>, acc),
    do: scan_char_class(rest, [{:char, <<c::utf8>>} | acc])

  defp format_class_items([], acc), do: acc |> Enum.reverse() |> IO.iodata_to_binary()

  defp format_class_items([{:char, a}, {:char, "-"}, {:char, b} | rest], acc) do
    format_class_items(rest, [escape_class_char(a) <> "-" <> escape_class_char(b) | acc])
  end

  defp format_class_items([{_, ch} | rest], acc) do
    format_class_items(rest, [escape_class_char(ch) | acc])
  end

  defp escape_class_char("\\"), do: "\\\\"
  defp escape_class_char("]"), do: "\\]"
  defp escape_class_char("["), do: "\\["
  defp escape_class_char("^"), do: "\\^"
  defp escape_class_char("-"), do: "\\-"
  defp escape_class_char(ch), do: ch

  # ── Live composite overlay ──

  defp load_composite(now_ms) do
    {local_host, local_entries, local_stale} = local_poller_feed()

    remote_feeds =
      try do
        RemoteFiberRegistry.feeds()
      catch
        :exit, _ -> %{}
      end

    remote_entries =
      Enum.flat_map(remote_feeds, fn {name, feed} ->
        (feed.fibers || [])
        |> Enum.map(&Map.put(&1, "origin", name))
        |> Lifecycle.stamp()
      end)

    all_entries =
      Enum.map(local_entries, &Map.put(&1, :origin, local_host)) ++ remote_entries

    live_by_uid =
      Enum.reduce(all_entries, %{}, fn entry, acc ->
        fiber = field(entry, :fiber) || %{}
        uid = fiber["uid"]
        runtime = field(entry, :runtime)
        live? = runtime != nil
        column = field(entry, :column) || Lifecycle.column(fiber, live?)

        if is_binary(uid) and uid != "" and is_binary(column) and column != "" do
          turn =
            field(entry, :turn) ||
              Lifecycle.turn(fiber, live?, runtime, field(entry, :dispatch_error), now_ms)

          origin = field(entry, :origin) || get_in(fiber, ["shuttle", "host"])
          rex_session = field(runtime, :rex_session)

          Map.put(acc, uid, %{
            column: column,
            turn: turn,
            origin: origin,
            rex_session: rex_session
          })
        else
          acc
        end
      end)

    origins =
      remote_feeds
      |> Map.new(fn {name, feed} ->
        {name, %{"stale" => !!feed.stale, "fibers" => length(feed.fibers || [])}}
      end)
      |> then(fn map ->
        if is_binary(local_host) and local_host != "" do
          Map.put(map, local_host, %{"stale" => local_stale, "fibers" => length(local_entries)})
        else
          map
        end
      end)

    {live_by_uid, origins}
  end

  defp local_poller_feed do
    case Poller.cached_fiber_documents(felt_stores: FeltStores.configured_stores()) do
      {:ok, %{host: host, fibers: entries} = body} ->
        stale? =
          case Map.get(body, :cache) do
            %{state: state} -> state != "fresh"
            _ -> false
          end

        {host, entries, stale?}

      _ ->
        {safe_own_host_id(), [], true}
    end
  catch
    :exit, _ -> {safe_own_host_id(), [], true}
  end

  defp safe_own_host_id do
    Poller.own_host_id()
  rescue
    _ -> nil
  catch
    :exit, _ -> nil
  end

  defp field(nil, _key), do: nil
  defp field(map, key), do: Map.get(map, key, Map.get(map, Atom.to_string(key)))

  # ── Assembly ──

  defp assemble(
         all_rows,
         allowed,
         mount_prefixes,
         excludes,
         live_by_uid,
         origins,
         config,
         now_dt,
         now_ms
       ) do
    allowed_ids = MapSet.new(allowed, & &1.row["id"])
    by_id = Map.new(allowed, &{&1.row["id"], &1})

    base_guild =
      config
      |> Map.get(:guild_roots, [])
      |> string_list()
      |> Enum.reduce(@base_guild, &MapSet.put(&2, &1))

    guild_roots =
      Enum.reduce(mount_prefixes, base_guild, fn mount, acc ->
        acc
        |> MapSet.put("#{mount}/roles")
        |> MapSet.put("#{mount}/practices")
        |> MapSet.put("#{mount}/#{mount}")
      end)

    {root_size, root_cities, root_active_cities} =
      Enum.reduce(allowed, {%{}, %{}, %{}}, fn %{row: r}, {sizes, cities, active} ->
        root = root_of(r["id"], mount_prefixes)
        sizes = Map.update(sizes, root, 1, &(&1 + 1))

        case r["shuttle"] do
          %{} = s ->
            cities = Map.update(cities, root, 1, &(&1 + 1))
            l = live_by_uid[r["uid"]]
            st = city_state(l && l.column, l && l.turn, r["status"], r["horizon"], s["kind"], s["ask"])
            active = if st in ["closed", "settled"], do: active, else: Map.update(active, root, 1, &(&1 + 1))
            {sizes, cities, active}

          _ ->
            {sizes, cities, active}
        end
      end)

    root_to_continent =
      Map.new(Map.keys(root_size), fn root ->
        {root,
         classify_continent(
           root,
           mount_prefixes,
           guild_roots,
           root_size,
           root_cities,
           root_active_cities,
           by_id,
           config
         )}
      end)

    dropped =
      for {root, nil} <- root_to_continent, into: MapSet.new(), do: root

    rollup_target = config.shared_rollup && config.shared_rollup.target

    slugs =
      Enum.reduce(all_rows, %{}, fn row, acc ->
        case row["id"] do
          id when is_binary(id) and id != "" ->
            slug = last_segment(id)
            Map.update(acc, slug, [id], &[id | &1])

          _ ->
            acc
        end
      end)
      |> Map.new(fn {slug, list} -> {slug, Enum.uniq(list)} end)

    state = %{
      continents: %{},
      areas: %{},
      cities: [],
      area_links: %{},
      domain_links: %{},
      fiber_cited_by: %{},
      area_cited_by: %{},
      cont_cited_by: %{},
      cont_top_areas: %{},
      area_top_children: %{},
      cont_recency: %{},
      area_recency: %{},
      cont_decisions: %{},
      area_decisions: %{}
    }

    final =
      Enum.reduce(allowed, state, fn %{row: r, file: file, store_name: store_name, shared?: shared?}, acc ->
        id = r["id"]
        root = root_of(id, mount_prefixes)

        if MapSet.member?(dropped, root) do
          acc
        else
          continent = root_to_continent[root]
          area = area_of(id, root, continent, rollup_target)
          parts = String.split(id, "/")
          root_depth = length(String.split(root, "/"))
          area_depth_base = length(String.split(area, "/"))
          rel_depth = max(0, length(parts) - root_depth)
          area_depth = max(0, length(parts) - area_depth_base)
          ts = fiber_timestamp(r, shared?, now_ms)
          decay = :math.exp(-max(0, now_ms - ts) / (21 * @day_ms))

          decision? =
            is_list(r["tags"]) and Enum.any?(r["tags"], &Regex.match?(~r/decision/i, to_string(&1)))

          acc =
            if decision? do
              acc
              |> update_in([:area_decisions], &Map.update(&1, area, 1, fn n -> n + 1 end))
              |> update_in([:cont_decisions], &Map.update(&1, continent, 1, fn n -> n + 1 end))
            else
              acc
            end

          cont_entry =
            Map.get(acc.continents, continent, %{
              id: continent,
              name: nil,
              total: 0,
              all_shared: true,
              cities: 0,
              stores: MapSet.new(),
              max_depth: 0
            })

          cont_name =
            if id == root and not Map.has_key?(config.display, continent) and continent == root do
              short_name(r["name"], last_segment(root))
            else
              cont_entry.name
            end

          cont_entry = %{
            cont_entry
            | total: cont_entry.total + 1,
              all_shared: cont_entry.all_shared and shared?,
              stores: MapSet.put(cont_entry.stores, store_name),
              max_depth: max(cont_entry.max_depth, rel_depth),
              name: cont_name
          }

          area_entry =
            Map.get(acc.areas, area, %{
              id: area,
              name: nil,
              continent: continent,
              mass: 0,
              shared: shared?,
              cities: 0,
              max_depth: 0,
              sample_fibers: [],
              all_fibers: []
            })

          fiber_label =
            (r["name"] || last_segment(id))
            |> to_string()
            |> String.trim()
            |> String.slice(0, 56)

          sample_label = String.slice(fiber_label, 0, 48)

          sample_fibers =
            if length(area_entry.sample_fibers) < 8 and sample_label != "" and
                 sample_label not in area_entry.sample_fibers do
              area_entry.sample_fibers ++ [sample_label]
            else
              area_entry.sample_fibers
            end

          fiber_item = %{
            id: id,
            name: if(fiber_label == "", do: last_segment(id), else: fiber_label),
            status: r["status"] || "open"
          }

          area_name =
            if id == area do
              Map.get(config.display, area) || short_name(r["name"], last_segment(area))
            else
              area_entry.name
            end

          area_entry = %{
            area_entry
            | mass: area_entry.mass + 1,
              max_depth: max(area_entry.max_depth, area_depth),
              sample_fibers: sample_fibers,
              all_fibers: [fiber_item | area_entry.all_fibers],
              name: area_name
          }

          sub_parts =
            id
            |> String.slice(String.length(area)..-1//1)
            |> String.trim_leading("/")
            |> String.split("/", trim: true)

          acc = %{
            acc
            | continents: Map.put(acc.continents, continent, cont_entry),
              areas: Map.put(acc.areas, area, area_entry),
              cont_recency: update_recency(acc.cont_recency, continent, decay, ts),
              area_recency: update_recency(acc.area_recency, area, decay, ts),
              cont_top_areas:
                Map.update(acc.cont_top_areas, continent, MapSet.new([area]), &MapSet.put(&1, area)),
              area_top_children:
                case sub_parts do
                  [child | _] ->
                    Map.update(acc.area_top_children, area, MapSet.new([child]), &MapSet.put(&1, child))

                  [] ->
                    acc.area_top_children
                end
          }

          targets = extract_links(r, file, allowed_ids, slugs, mount_prefixes, excludes)

          acc =
            Enum.reduce(targets, acc, fn target, link_acc ->
              troot = root_of(target, mount_prefixes)

              if MapSet.member?(dropped, troot) do
                link_acc
              else
                tc = root_to_continent[troot]
                ta = area_of(target, troot, tc, rollup_target)

                link_acc = %{
                  link_acc
                  | fiber_cited_by: Map.update(link_acc.fiber_cited_by, target, 1, &(&1 + 1)),
                    area_cited_by: Map.update(link_acc.area_cited_by, ta, 1, &(&1 + 1)),
                    cont_cited_by: Map.update(link_acc.cont_cited_by, tc, 1, &(&1 + 1))
                }

                cond do
                  tc == continent and ta != area ->
                    key = ordered_pair(area, ta)
                    %{link_acc | area_links: Map.update(link_acc.area_links, key, 1, &(&1 + 1))}

                  tc != continent ->
                    key = ordered_pair(continent, tc)
                    %{link_acc | domain_links: Map.update(link_acc.domain_links, key, 1, &(&1 + 1))}

                  true ->
                    link_acc
                end
              end
            end)

          case r["shuttle"] do
            %{} = s ->
              l = live_by_uid[r["uid"]]
              parent = find_shuttle_parent(parts, by_id)
              origin = (l && l.origin) || s["host"]

              tempered? =
                not (
                  (l != nil and l.column == "discarded") or
                    r["tempered"] == false or
                    (is_list(r["tags"]) and "discarded" in r["tags"])
                )

              city = %{
                "id" => id,
                "uid" => r["uid"],
                "name" =>
                  (r["name"] || last_segment(id)) |> to_string() |> String.slice(0, 72),
                "continent" => continent,
                "area" => area,
                "parent" => parent,
                "depth" => rel_depth,
                "state" => city_state(l && l.column, l && l.turn, r["status"], r["horizon"], s["kind"], s["ask"]),
                "tempered" => tempered?,
                "column" => l && l.column,
                "turn" => l && l.turn,
                "live" => l != nil,
                "host" => origin,
                "origin" => origin,
                "agent" => s["agent"],
                "kind" => s["kind"] || "oneshot",
                "channel" => s["channel"],
                "isOrchestrator" =>
                  s["role"] == "orchestrator" or truthy?(s["seat"]) or truthy?(r["seat"]),
                "rexSession" => l && l.rex_session,
                "hasTapestry" =>
                  truthy?(r["report_path"]) or
                    FS.exists?(Path.join(Path.dirname(file), "tapestry.html")),
                "createdAt" => valid_iso_or_nil(r["created_at"])
              }

              %{
                acc
                | continents:
                    Map.update!(acc.continents, continent, &%{&1 | cities: &1.cities + 1}),
                  areas: Map.update!(acc.areas, area, &%{&1 | cities: &1.cities + 1}),
                  cities: [city | acc.cities]
              }

            _ ->
              acc
          end
        end
      end)

    continents =
      final.continents
      |> Map.values()
      |> Enum.map(fn c ->
        cr = Map.get(final.cont_recency, c.id, %{weight: 0.0, last_ms: 0})
        kind = continent_kind(c.id)

        name =
          Map.get(config.display, c.id) ||
            Map.get(@default_display, c.id) ||
            c.name ||
            short_name(nil, last_segment(c.id))

        %{
          "id" => c.id,
          "name" => name,
          "kind" => kind,
          "shared" => c.total > 0 and c.all_shared and kind == "project",
          "stores" => c.stores |> MapSet.to_list() |> Enum.sort(),
          "total" => c.total,
          "cities" => c.cities,
          "citedBy" => Map.get(final.cont_cited_by, c.id, 0),
          "maxDepth" => max(c.max_depth, 1),
          "topLevelBreadth" => max(MapSet.size(Map.get(final.cont_top_areas, c.id, MapSet.new())), 1),
          "decisionCount" => Map.get(final.cont_decisions, c.id, 0),
          "recentRatio" => Float.round(min(1.0, cr.weight / max(1, c.total)), 3),
          "lastUpdated" => ms_to_iso(cr.last_ms)
        }
      end)
      |> Enum.sort_by(& &1["id"])

    areas =
      final.areas
      |> Map.values()
      |> Enum.map(fn a ->
        ar = Map.get(final.area_recency, a.id, %{weight: 0.0, last_ms: 0})

        name =
          Map.get(config.display, a.id) ||
            a.name ||
            short_name(nil, last_segment(a.id))

        fiber_items =
          a.all_fibers
          |> Enum.map(fn f ->
            %{
              "id" => f.id,
              "name" => f.name,
              "status" => f.status,
              "citedBy" => Map.get(final.fiber_cited_by, f.id, 0)
            }
          end)
          |> Enum.sort_by(fn f -> {-f["citedBy"], f["id"]} end)
          |> Enum.take(24)

        %{
          "id" => a.id,
          "name" => name,
          "continent" => a.continent,
          "mass" => a.mass,
          "shared" => a.shared,
          "cities" => a.cities,
          "citedBy" => Map.get(final.area_cited_by, a.id, 0),
          "maxDepth" => a.max_depth,
          "topLevelBreadth" =>
            max(MapSet.size(Map.get(final.area_top_children, a.id, MapSet.new())), 1),
          "decisionCount" => Map.get(final.area_decisions, a.id, 0),
          "recentRatio" => Float.round(min(1.0, ar.weight / max(1, a.mass)), 3),
          "lastUpdated" => ms_to_iso(ar.last_ms),
          "sampleFibers" => a.sample_fibers,
          "fiberItems" => fiber_items
        }
      end)
      |> Enum.sort_by(& &1["id"])

    area_links =
      final.area_links
      |> Enum.filter(fn {_k, w} -> w >= 2 end)
      |> Enum.map(fn {{a, b}, w} -> %{"a" => a, "b" => b, "w" => w} end)
      |> Enum.sort_by(&{&1["a"], &1["b"]})

    domain_links =
      final.domain_links
      |> Enum.map(fn {{a, b}, w} -> %{"a" => a, "b" => b, "w" => w} end)
      |> Enum.sort_by(&{&1["a"], &1["b"]})

    cities =
      final.cities
      |> Enum.map(&Map.put(&1, "citedBy", Map.get(final.fiber_cited_by, &1["id"], 0)))
      |> Enum.sort_by(& &1["id"])

    %{
      "generatedAt" => DateTime.to_iso8601(now_dt),
      "origins" => origins,
      "mapConfig" => %{
        "seas" => config.seas,
        "pins" => config.pins
      },
      "continents" => continents,
      "areas" => areas,
      "areaLinks" => area_links,
      "domainLinks" => domain_links,
      "cities" => cities
    }
  end

  # ── Geography & classification helpers ──

  defp root_of(id, mount_prefixes) do
    case String.split(id, "/") do
      [first, second | _] ->
        if MapSet.member?(mount_prefixes, first), do: "#{first}/#{second}", else: first

      [first] ->
        first
    end
  end

  defp shared_root?(root, mount_prefixes) do
    first = root |> String.split("/") |> List.first("")
    MapSet.member?(mount_prefixes, first)
  end

  defp classify_continent(
         root,
         mount_prefixes,
         guild_roots,
         root_size,
         root_cities,
         root_active_cities,
         by_id,
         config
       ) do
    cond do
      MapSet.member?(guild_roots, root) ->
        "guild"

      Map.has_key?(config.merge, root) ->
        config.merge[root]

      Map.get(root_size, root, 0) <= 4 and Map.get(root_cities, root, 0) == 0 ->
        tags =
          case Map.get(by_id, root) do
            %{row: %{"tags" => t}} when is_list(t) -> t
            _ -> []
          end

        if not shared_root?(root, mount_prefixes) and "task" in tags do
          nil
        else
          "shoals"
        end

      matches_shared_rollup?(root, root_cities, root_active_cities, config.shared_rollup) ->
        config.shared_rollup.target

      true ->
        root
    end
  end

  defp matches_shared_rollup?(_root, _root_cities, _root_active_cities, nil), do: false

  defp matches_shared_rollup?(root, root_cities, root_active_cities, %{
         mount: mount,
         target: target,
         max_cities: max_cities
       }) do
    String.starts_with?(root, mount <> "/") and
      root != target and
      Map.get(root_active_cities, root, 0) == 0 and
      Map.get(root_cities, root, 0) <= max_cities
  end

  defp area_of(id, root, continent, rollup_target) do
    if continent in ["guild", "shoals"] or (is_binary(rollup_target) and continent == rollup_target) do
      root
    else
      depth = length(String.split(root, "/"))
      parts = String.split(id, "/")

      if length(parts) > depth do
        parts |> Enum.take(depth + 1) |> Enum.join("/")
      else
        root
      end
    end
  end

  defp continent_kind("guild"), do: "guild"
  defp continent_kind("shoals"), do: "shoals"
  defp continent_kind(_), do: "project"

  @doc false
  def city_state(column, turn, status, horizon, kind, ask \\ nil) do
    cond do
      is_binary(column) and column != "" ->
        cond do
          column in ["tempered", "discarded"] -> "closed"
          turn in ["question", "blocked"] or (status == "active" and has_active_ask?(ask)) -> "ask"
          column == "awaiting_review" -> "review"
          column == "in_flight" -> "working"
          column == "drafts" -> "draft"
          true -> "resting"
        end

      status == "closed" ->
        "closed"

      status == "active" and has_active_ask?(ask) ->
        "ask"

      horizon == "stashed" or kind == "standing" or status == "active" ->
        "resting"

      true ->
        "draft"
    end
  end

  defp has_active_ask?(text) when is_binary(text), do: String.trim(text) != ""
  defp has_active_ask?(%{"text" => text}) when is_binary(text), do: String.trim(text) != ""
  defp has_active_ask?(_), do: false

  defp find_shuttle_parent(parts, by_id) when length(parts) > 1 do
    Enum.find_value((length(parts) - 1)..1//-1, fn idx ->
      candidate = parts |> Enum.take(idx) |> Enum.join("/")

      case Map.get(by_id, candidate) do
        %{row: %{"shuttle" => %{}}} -> candidate
        _ -> nil
      end
    end)
  end

  defp find_shuttle_parent(_parts, _by_id), do: nil

  # ── Wikilink & dependency extraction ──

  defp extract_links(row, file, allowed_ids, slugs, mount_prefixes, excludes) do
    source = row["id"]

    {fm_text, body_text} =
      case FS.read(file) do
        {:ok, raw} ->
          case Regex.run(@frontmatter_re, raw) do
            [full, fm] ->
              rest = binary_part(raw, byte_size(full), byte_size(raw) - byte_size(full))
              {fm, strip_code(rest)}

            _ ->
              {"", strip_code(raw)}
          end

        {:error, _} ->
          {"", ""}
      end

    raw_targets =
      wikilink_targets(body_text) ++
        wikilink_targets(fm_text) ++
        depends_on_targets(row["depends_on"]) ++
        input_targets(row["inputs"])

    Enum.reduce(raw_targets, MapSet.new(), fn raw, acc ->
      case resolve_target(raw, source, allowed_ids, slugs, mount_prefixes, excludes) do
        nil -> acc
        ^source -> acc
        resolved -> MapSet.put(acc, resolved)
      end
    end)
  end

  defp strip_code(text) do
    text
    |> then(&Regex.replace(@fenced_code_re, &1, ""))
    |> then(&Regex.replace(@inline_code_re, &1, ""))
  end

  defp wikilink_targets(""), do: []

  defp wikilink_targets(text) do
    Regex.scan(@wikilink_re, text, capture: :all_but_first)
    |> List.flatten()
  end

  defp depends_on_targets(list) when is_list(list), do: Enum.filter(list, &is_binary/1)
  defp depends_on_targets(_), do: []

  defp input_targets(list) when is_list(list) do
    Enum.flat_map(list, fn
      s when is_binary(s) ->
        [s]

      %{} = inp ->
        [inp["from"], inp["source"], inp["id"]] |> Enum.filter(&is_binary/1)

      _ ->
        []
    end)
  end

  defp input_targets(_), do: []

  defp resolve_target(raw, source, allowed_ids, slugs, mount_prefixes, excludes) do
    t =
      raw
      |> to_string()
      |> String.trim()
      |> String.split("|", parts: 2)
      |> List.first("")
      |> String.split("#", parts: 2)
      |> List.first("")
      |> String.trim()
      |> String.replace(~r/\.md$/, "")
      |> String.replace(~r/^\.?\//, "")

    cond do
      t == "" or excluded?(t, excludes) or ".." in String.split(t, "/") ->
        nil

      true ->
        source_mount =
          case String.split(source, "/", parts: 2) do
            [first, _] -> if MapSet.member?(mount_prefixes, first), do: first, else: nil
            _ -> nil
          end

        candidates =
          [t] ++
            if(source_mount, do: ["#{source_mount}/#{t}"], else: []) ++
            Enum.map(mount_prefixes, &"#{&1}/#{t}")

        case Enum.find(candidates, &MapSet.member?(allowed_ids, &1)) do
          nil ->
            case Map.get(slugs, t) do
              [single] -> if MapSet.member?(allowed_ids, single), do: single, else: nil
              _ -> nil
            end

          found ->
            found
        end
    end
  end

  # ── Timestamps, names, and formatting ──

  defp fiber_timestamp(row, shared?, now_ms) do
    valid_created = parse_iso_ms(row["created_at"])
    ulid_ts = ulid_ms(row["uid"])
    base_created = max(valid_created, ulid_ts)
    valid_mod = parse_iso_ms(row["modified_at"])

    trusted_mod =
      if not shared? do
        valid_mod
      else
        if valid_mod > 0 and (now_ms - valid_mod <= 7 * @day_ms or base_created == 0),
          do: valid_mod,
          else: 0
      end

    ts = max(base_created, trusted_mod)
    if ts > 0, do: ts, else: now_ms - 90 * @day_ms
  end

  defp parse_iso_ms(val) when is_binary(val) do
    if String.starts_with?(val, "0001") do
      0
    else
      case DateTime.from_iso8601(val) do
        {:ok, dt, _} -> DateTime.to_unix(dt, :millisecond)
        _ -> 0
      end
    end
  end

  defp parse_iso_ms(_), do: 0

  defp valid_iso_or_nil(val) when is_binary(val) and val != "" do
    if String.starts_with?(val, "0001"), do: nil, else: val
  end

  defp valid_iso_or_nil(_), do: nil

  defp ulid_ms(uid) when is_binary(uid) do
    if Regex.match?(@ulid_re, uid) do
      uid
      |> String.slice(0, 10)
      |> String.upcase()
      |> String.to_charlist()
      |> Enum.reduce(0, fn ch, acc ->
        idx =
          case :binary.match(@ulid_alphabet, <<ch>>) do
            {pos, 1} -> pos
            :nomatch -> 0
          end

        acc * 32 + idx
      end)
    else
      0
    end
  end

  defp ulid_ms(_), do: 0

  @doc false
  def ms_to_iso(ms) when is_integer(ms) and ms > 0 do
    case DateTime.from_unix(ms, :millisecond) do
      {:ok, dt} -> DateTime.to_iso8601(dt)
      _ -> nil
    end
  end

  def ms_to_iso(_), do: nil

  defp update_recency(map, key, decay, ts) do
    Map.update(map, key, %{weight: decay, last_ms: ts}, fn cur ->
      %{weight: cur.weight + decay, last_ms: max(cur.last_ms, ts)}
    end)
  end

  defp short_name(name, slug) do
    first =
      (name || "")
      |> to_string()
      |> String.split(~r/ — | – |: /)
      |> List.first("")
      |> String.trim()

    title =
      slug
      |> String.replace(~r/[-_]+/, " ")
      |> String.split(" ")
      |> Enum.map_join(" ", fn
        "" -> ""
        word -> String.upcase(String.slice(word, 0, 1)) <> String.slice(word, 1..-1//1)
      end)

    norm_slug = slug |> String.replace(~r/[-_]/, " ") |> String.downcase()

    if first != "" and String.length(first) <= 26 and String.downcase(first) != norm_slug do
      first
    else
      title
    end
  end

  defp last_segment(path), do: path |> String.split("/") |> List.last("")
  defp ordered_pair(a, b) when a <= b, do: {a, b}
  defp ordered_pair(a, b), do: {b, a}

  defp truthy?(val) when val in [nil, false, ""], do: false
  defp truthy?(_), do: true
end
