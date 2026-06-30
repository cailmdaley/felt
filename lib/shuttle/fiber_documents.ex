defmodule Shuttle.FiberDocuments do
  @moduledoc """
  Daemon-local document reads for clients that need the owning host's fibers.

  Shuttle owns runtime state, but felt remains the document reader. This module
  shells out to `felt ls` for each configured store and returns the raw felt JSON
  entry plus enough path metadata for remote clients to render and mutate cards
  without relying on Portolan's WebSocket fiber-tree snapshots.
  """

  alias Shuttle.FeltStores

  @type entry :: %{
          required(:felt_store) => String.t(),
          required(:path) => String.t(),
          required(:fiber) => map(),
          optional(:dir) => String.t(),
          optional(:report_path) => String.t()
        }

  # The metadata fields the kanban board needs from each Shuttle fiber.
  @kanban_json_fields Enum.join(
                        ~w(id uid name status tags created_at closed_at modified_at
                           outcome due horizon cold kind priority depends_on tempered
                           shuttle path),
                        ","
                      )

  @spec list(keyword()) :: {:ok, map()} | {:error, term()}
  def list(opts \\ []) do
    mode = if Keyword.get(opts, :shuttle_only, false), do: :owned, else: :all
    collect(opts, Keyword.get(opts, :with_body, false), mode)
  end

  defp collect(opts, with_body?, mode) do
    stores = Keyword.get_lazy(opts, :felt_stores, &FeltStores.configured_hosts/0)

    results = Enum.map(stores, &list_store(&1, with_body?, mode))
    errors = Enum.flat_map(results, &store_errors/1)

    if errors == [] do
      entries =
        results
        |> Enum.flat_map(fn {:ok, rows} -> rows end)
        |> unique_entries()

      {:ok, envelope(stores, entries)}
    else
      {:error, errors}
    end
  end

  @doc """
  Builds the wire entry for one felt JSON fiber.

  The poller uses this for its document cache so cached `/api/v1/fibers`
  responses preserve the same path, slug, logical-id, and report sibling
  semantics as the direct felt-list path.
  """
  @spec entries_for_fiber(String.t(), map()) :: [entry()]
  def entries_for_fiber(store, fiber), do: entry_for(store, fiber)

  @spec envelope([String.t()], [entry()]) :: map()
  def envelope(stores, entries) do
    %{
      host: own_host_id(),
      felt_stores: stores,
      generated_at: DateTime.to_iso8601(DateTime.utc_now()),
      fibers: entries
    }
  end

  @doc """
  Resolve a SINGLE fiber by its canonical id without dragging in the whole
  store. This is the per-fiber dual of `list/1`: Portolan resolves a remote
  fiber's content/owner (kanban card → vellum view) through this instead of
  fetching every fiber and linear-scanning, collapsing a ~3.5MB cross-tunnel
  transfer to one fiber.

  Two-tier lookup:

    * **Fast path** — `felt show <id> -j` per store. For a fiber physically
      rooted in the store the canonical id equals felt's traversal id, so the
      direct show resolves in milliseconds.
    * **Scan fallback** — for a symlink-traversed fiber (loom's `.felt/shapepipe`
      → a separate project store) the canonical id drops the store prefix, so
      `felt show <canonical-id>` misses. We then reuse the `list/1` machinery to
      enumerate the store and match on the canonical id. This costs a full
      `felt ls` daemon-side but still returns a single fiber over the wire, and
      only fires for the handful of symlinked-out projects.

  Returns the same `{:ok, %{host, felt_stores, fibers: […]}}` envelope as
  `list/1` with zero or one fiber, so Portolan reuses the same response parser.
  A missing fiber is `{:ok, …, fibers: []}` (not an error); a felt failure
  during the scan fallback surfaces as `{:error, errors}`.
  """
  @spec get(String.t(), keyword()) :: {:ok, map()} | {:error, term()}
  def get(id, opts \\ []) do
    stores = Keyword.get_lazy(opts, :felt_stores, &FeltStores.configured_hosts/0)
    with_body? = Keyword.get(opts, :with_body, false)

    case fast_lookup(stores, id, with_body?) do
      {:ok, entry} -> {:ok, envelope(stores, [entry])}
      :miss -> scan_lookup(stores, id, with_body?)
    end
  end

  # Direct `felt show` per store; first store that resolves the id wins.
  defp fast_lookup(stores, id, with_body?) do
    Enum.find_value(stores, :miss, fn store ->
      case show_store(store, id, with_body?) do
        {:ok, [entry | _]} -> {:ok, entry}
        _ -> nil
      end
    end)
  end

  defp show_store(store, id, with_body?) do
    # `felt show -j` emits the full fiber JSON — always `id` and `path`, plus
    # `body` whenever the fiber has one. Do NOT append `--body`: that selector
    # switches felt to a minimal `{body, body_start_line}` shape with NO `id`, so
    # `entry_for/2` (which keys on `id`) drops it, `fast_lookup/3` misses on every
    # store, and `get/2` falls all the way through to the whole-store
    # `scan_lookup` — a `felt ls --body` over every configured store, which under
    # poller churn cost the body-read endpoint 6-10s while felt itself answered in
    # ~10ms. The body is already in hand here: keep it for the content reader,
    # drop it (a no-op when the fiber has none) for the metadata path so the
    # response still matches the list endpoint's body=… contract.
    #
    # Same stderr discipline as list_store: never fold stderr into stdout — felt
    # prints "no felt found matching …" (and parse warnings) to stderr while
    # emitting JSON on stdout. A missing fiber exits non-zero with empty stdout,
    # which we treat as "not in this store" and fall through to the next.
    case System.cmd("felt", ["show", id, "-j"], cd: store) do
      {output, 0} ->
        case Jason.decode(output) do
          {:ok, %{} = fiber} ->
            fiber = if with_body?, do: fiber, else: Map.delete(fiber, "body")
            {:ok, entry_for(store, fiber)}

          _ ->
            :miss
        end

      {_output, _status} ->
        :miss
    end
  end

  # Enumerate each store and match the requested canonical id. Reuses list_store
  # so the entry shape (canonical id, store-relative path, report_path) is
  # byte-identical to the list endpoint.
  defp scan_lookup(stores, id, with_body?) do
    results = Enum.map(stores, &list_store(&1, with_body?, :all))
    errors = Enum.flat_map(results, &store_errors/1)

    match =
      results
      |> Enum.flat_map(fn
        {:ok, rows} -> rows
        _ -> []
      end)
      |> Enum.find(&entry_matches_id?(&1, id))

    cond do
      match != nil -> {:ok, envelope(stores, [match])}
      errors != [] -> {:error, errors}
      true -> {:ok, envelope(stores, [])}
    end
  end

  defp list_store(store, with_body?, mode) do
    args = list_args(with_body?, mode)

    # Do NOT fold stderr into stdout: felt prints `warning: failed to parse …`
    # for stray non-fiber `.md` files (SPEC.md, README.md) to stderr while still
    # emitting valid JSON on stdout and exiting 0. Capturing stderr would prepend
    # those warnings to the JSON and break Jason.decode for the whole store —
    # 500ing the entire /fibers endpoint. Felt's warnings land in the daemon log
    # instead; only stdout is parsed.
    case System.cmd("felt", args, cd: store) do
      {output, 0} ->
        decode_store(store, output, mode)

      {output, status} ->
        {:error, %{felt_store: store, status: status, error: String.trim(output)}}
    end
  end

  # `with_body? == true` is the content/search reader path: every field, body
  # included, no narrowing. The narrowed owner walk carries only kanban metadata
  # fields and never the body.
  defp list_args(true, _mode), do: ["ls", "-s", "all", "-j", "--body"]

  defp list_args(false, :owned) do
    ["ls", "-s", "all", "-j", "--has-field", "shuttle", "--json-field", @kanban_json_fields]
  end

  defp list_args(false, :all), do: ["ls", "-s", "all", "-j"]

  defp decode_store(store, output, mode) do
    with {:ok, decoded} when is_list(decoded) <- Jason.decode(output) do
      rows = filter_rows(decoded, mode)
      {:ok, rows |> Enum.flat_map(&entry_for(store, &1))}
    else
      {:ok, _} -> {:error, %{felt_store: store, error: "felt ls returned non-list JSON"}}
      {:error, error} -> {:error, %{felt_store: store, error: Exception.message(error)}}
    end
  end

  defp filter_rows(rows, :owned), do: Enum.filter(rows, &owned_kanban_fiber?/1)
  defp filter_rows(rows, _all), do: rows

  defp unique_entries(entries) do
    {_seen, unique} =
      Enum.reduce(entries, {MapSet.new(), []}, fn entry, {seen, acc} ->
        key = entry_identity(entry)

        if key != nil and MapSet.member?(seen, key) do
          {seen, acc}
        else
          {if(key == nil, do: seen, else: MapSet.put(seen, key)), [entry | acc]}
        end
      end)

    Enum.reverse(unique)
  end

  defp entry_identity(%{fiber: fiber} = entry) do
    cond do
      present?(Map.get(fiber, "uid")) -> {:uid, Map.fetch!(fiber, "uid")}
      present?(Map.get(entry, :dir)) -> {:dir, Map.fetch!(entry, :dir)}
      present?(Map.get(fiber, "path")) -> {:path, Map.fetch!(fiber, "path")}
      present?(Map.get(fiber, "slug")) -> {:slug, Map.fetch!(fiber, "slug")}
      present?(Map.get(fiber, "id")) -> {:id, Map.fetch!(fiber, "id")}
      true -> nil
    end
  end

  defp entry_identity(_), do: nil

  defp present?(value), do: is_binary(value) and value != ""

  # The kanban (`?shuttle=true`) feed serves only the rows THIS daemon owns:
  # a non-empty `shuttle:` block AND `shuttle.host == own_host_id`. The feed is
  # consumed cross-tunnel as a REMOTE origin, and the owner-only contract is that
  # each daemon answers strictly for its host-owned fibers — a viewer concatenates
  # owners' answers and never merges, because no fiber is authoritatively present
  # on two hosts. A fiber physically rooted here but pinned to another host's
  # `shuttle.host:` belongs to that host's feed, never this one's mirror.
  defp owned_kanban_fiber?(fiber) do
    shuttle_fiber?(fiber) and host_owned?(fiber)
  end

  # A fiber is owner-feed-relevant iff it carries a non-empty `shuttle:` block.
  defp shuttle_fiber?(%{"shuttle" => shuttle}) when is_map(shuttle) and map_size(shuttle) > 0,
    do: true

  defp shuttle_fiber?(_), do: false

  # Host-ownership: a fiber is owned by this daemon iff its `shuttle.host`
  # equals `own_host_id`. Strict equality — an absent or empty `host:` is
  # unowned everywhere (no wildcard), so it never appears in any daemon's feed.
  # Mirrors `Shuttle.Poller`'s dispatch-side predicate; the feed and the
  # dispatch plane agree on exactly one owner per fiber.
  defp host_owned?(%{"shuttle" => %{"host" => host}}) when is_binary(host) and host != "" do
    host == own_host_id()
  end

  defp host_owned?(_), do: false

  defp entry_for(store, %{"id" => id} = fiber) when is_binary(id) and id != "" do
    # Three values, all read from felt, none reverse-derived or guessed by Shuttle:
    #
    #   * The wire `path` is the SERVED-store-relative address Portolan opens the
    #     file by (`felt_store` + `path`). Portolan's `loomRelativeWirePath`
    #     depends on this served-relative shape, so it stays served-relative —
    #     but it is now READ from felt's carried `path` (its leaf shape) joined
    #     under felt's traversal `id` prefix, never guessed from `entry_point`.
    #     See `served_wire_path/1`.
    #
    #   * The card's `slug`/canonical id is the REALPATH store-relative slug
    #     (`review-ngmix`, where the bytes physically root), read from felt's
    #     carried absolute `path` — the same id `/state` keys the runtime by, so
    #     the kanban join matches.
    #
    #   * The card's logical `id` prefers felt's intrinsic `uid`, falling back to
    #     that canonical slug.
    wire_path = served_wire_path(fiber)
    canonical_id = canonical_id_from_path(fiber) || id
    logical_id = logical_id(fiber, canonical_id)

    fiber =
      fiber
      |> Map.put("id", logical_id)
      |> put_slug(canonical_id)

    entry = %{
      felt_store: store,
      path: wire_path,
      fiber: fiber
    }

    # The fiber's own directory (`dirname(felt.path)`) is the anchor two clients
    # need: the detail panel resolves a relative `:::{embed}` / image against it
    # before calling `/file?path=…`, and report.html is just its `report.html`
    # sibling. Emitted unconditionally (not gated on report.html existing) so
    # relative artifacts render for every local fiber, not only reported ones.
    # felt's `path` is symlink-canonicalized and already absolute — the exact
    # form `/file` reads by and Portolan serves over /project-file/<origin><abs>.
    case fiber_dir(fiber) do
      {:ok, dir} ->
        entry = Map.put(entry, :dir, dir)
        report_path = Path.join(dir, "report.html")

        if File.exists?(report_path),
          do: [Map.put(entry, :report_path, report_path)],
          else: [entry]

      :error ->
        [entry]
    end
  end

  defp entry_for(_store, _fiber), do: []

  defp entry_matches_id?(%{fiber: %{"id" => id}}, id), do: true
  defp entry_matches_id?(%{fiber: %{"slug" => id}}, id), do: true
  defp entry_matches_id?(_, _), do: false

  defp put_slug(%{"id" => id} = fiber, id), do: fiber
  defp put_slug(fiber, slug), do: Map.put(fiber, "slug", slug)

  # Served-store-relative wire path, the address Portolan opens the file by
  # (`felt_store` + `path`). The PREFIX comes from felt's traversal `id` (which
  # carries the served-store prefix a symlink-traversed fiber's realpath drops);
  # the LEAF SHAPE — flat `<leaf>.md` vs dir-contained `<leaf>/<leaf>.md` — comes
  # from felt's carried `path`, not from an `entry_point` guess. The leaf shape
  # is symlink-invariant (the symlink swaps the prefix, never the leaf), so the
  # realpath tail and the served file agree on it. Falls back to the dir-contained
  # shape only when felt carries no usable `path` (older binaries).
  defp served_wire_path(%{"id" => id} = fiber) do
    leaf = Path.basename(id)
    prefix = Path.dirname(id)
    leaf_file = leaf_shape(fiber, leaf)

    if prefix == ".", do: leaf_file, else: Path.join(prefix, leaf_file)
  end

  # `<leaf>/<leaf>.md` when felt's carried path is dir-contained, else `<leaf>.md`.
  defp leaf_shape(%{"path" => path}, leaf) when is_binary(path) and path != "" do
    parent = path |> Path.dirname() |> Path.basename()
    if parent == leaf, do: Path.join(leaf, "#{leaf}.md"), else: "#{leaf}.md"
  end

  defp leaf_shape(_fiber, leaf), do: Path.join(leaf, "#{leaf}.md")

  # The fiber's directory: `dirname(felt.path)`. felt's `path` is absolute and
  # symlink-canonicalized, so this is the real fiber dir in every topology
  # (dir-contained, symlinked-flat substore, entry point) with no served-store-
  # prefix coupling. `:error` when felt carries no `path`.
  defp fiber_dir(%{"path" => path}) when is_binary(path) and path != "" do
    {:ok, Path.dirname(Path.expand(path))}
  end

  defp fiber_dir(_fiber), do: :error

  # Canonical (realpath store-relative) id from felt's carried absolute `path`:
  # the tail after the physically-enclosing `.felt/`, minus the `<leaf>.md`
  # filename for dir-contained fibers. For a symlink-traversed fiber this drops
  # the served-store prefix felt's traversal `id` carries, recovering the slug
  # the owning store (and `/state`) addresses. nil when felt carries no `path`
  # (older binaries) — the caller falls back to felt's traversal `id`.
  defp canonical_id_from_path(%{"path" => path}) when is_binary(path) and path != "" do
    case String.split(path, "/.felt/", parts: 2) do
      [_prefix, tail] when tail != "" -> canonical_id_from_tail(tail)
      _ -> nil
    end
  end

  defp canonical_id_from_path(_), do: nil

  # `<slug>/<leaf>.md` (dir-contained) → `<slug>`; `<leaf>.md` (flat) → `<leaf>`.
  defp canonical_id_from_tail(tail) do
    leaf = tail |> Path.basename() |> String.replace_suffix(".md", "")
    parent = tail |> Path.dirname()

    cond do
      parent == "." -> leaf
      Path.basename(parent) == leaf -> parent
      true -> Path.join(parent, leaf)
    end
  end

  defp logical_id(fiber, fallback) do
    case Map.get(fiber, "uid") do
      uid when is_binary(uid) ->
        if Shuttle.ULID.valid?(uid), do: uid, else: fallback

      _ ->
        fallback
    end
  end

  defp store_errors({:ok, _rows}), do: []
  defp store_errors({:error, error}), do: [error]

  # The owned-feed predicate and the envelope `host:` must match exactly what
  # the dispatcher owns by, so both resolve through the single canonical
  # resolver rather than re-deriving the hostname here.
  defp own_host_id, do: Shuttle.Poller.own_host_id()
end
